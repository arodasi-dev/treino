#!/usr/bin/env python3
"""Copia seus dados do Firestore para o servidor (rode NO homeserver).

Uso:   cd ~/treino-app/servidor && python3 migrar.py

Pede o e-mail e a senha que você usa no app. Nada é apagado do Firestore, e
pode rodar de novo sem duplicar (os mesmos itens são só atualizados).
Só usa a biblioteca padrão do Python.
"""
import getpass
import json
import os
import re
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
COLS = ["workouts", "sessions", "drafts", "meta"]
REFERER = "https://arodasi-dev.github.io/"   # a chave do Firebase pode ser restrita a este site


def ler_env():
    env = {}
    try:
        for linha in open(os.path.join(HERE, ".env"), encoding="utf-8"):
            linha = linha.strip()
            if linha and not linha.startswith("#") and "=" in linha:
                k, v = linha.split("=", 1)
                env[k.strip()] = v.strip()
    except FileNotFoundError:
        sys.exit("Não achei o arquivo .env em %s. Crie-o primeiro (veja o README)." % HERE)
    return env


def ler_config_firebase():
    caminho = os.path.join(HERE, "..", "firebase-config.js")
    try:
        txt = open(caminho, encoding="utf-8").read()
    except FileNotFoundError:
        sys.exit("Não achei firebase-config.js em %s" % os.path.normpath(caminho))
    chave = re.search(r'apiKey\s*:\s*"([^"]+)"', txt)
    projeto = re.search(r'projectId\s*:\s*"([^"]+)"', txt)
    if not chave or not projeto:
        sys.exit("firebase-config.js sem apiKey/projectId.")
    return chave.group(1), projeto.group(1)


def http(metodo, url, corpo=None, headers=None):
    h = {"Referer": REFERER}
    h.update(headers or {})
    dados = None
    if corpo is not None:
        dados = json.dumps(corpo).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=dados, headers=h, method=metodo)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        detalhe = e.read().decode(errors="replace")[:300]
        raise RuntimeError("HTTP %d em %s: %s" % (e.code, url.split("?")[0], detalhe))


def valor(v):
    """Converte um valor do formato REST do Firestore para JSON comum."""
    if "stringValue" in v:
        return v["stringValue"]
    if "integerValue" in v:
        return int(v["integerValue"])
    if "doubleValue" in v:
        return v["doubleValue"]
    if "booleanValue" in v:
        return v["booleanValue"]
    if "nullValue" in v:
        return None
    if "timestampValue" in v:
        return v["timestampValue"]
    if "referenceValue" in v:
        return v["referenceValue"]
    if "geoPointValue" in v:
        return v["geoPointValue"]
    if "bytesValue" in v:
        return v["bytesValue"]
    if "arrayValue" in v:
        return [valor(x) for x in v["arrayValue"].get("values", [])]
    if "mapValue" in v:
        return {k: valor(x) for k, x in v["mapValue"].get("fields", {}).items()}
    raise ValueError("tipo desconhecido: %s" % list(v))


def documento(d):
    obj = {k: valor(x) for k, x in d.get("fields", {}).items()}
    if "id" not in obj:
        obj["id"] = d["name"].rsplit("/", 1)[-1]
    return obj


def ler_colecao(projeto, uid, col, token):
    base = "https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents/users/%s/%s" % (projeto, uid, col)
    docs, pagina = [], None
    while True:
        url = base + "?pageSize=300" + ("&pageToken=" + pagina if pagina else "")
        r = http("GET", url, headers={"Authorization": "Bearer " + token}) or {}
        docs += [documento(d) for d in r.get("documents", [])]
        pagina = r.get("nextPageToken")
        if not pagina:
            return docs


def main():
    env = ler_env()
    token_srv = env.get("TREINO_TOKEN", "")
    porta = env.get("HOST_PORT", "8787")
    srv = "http://127.0.0.1:%s" % porta
    h_srv = {"Authorization": "Bearer " + token_srv}
    chave, projeto = ler_config_firebase()

    print("Conferindo o servidor em %s ..." % srv)
    try:
        http("GET", srv + "/api/c/meta", headers=h_srv)
    except Exception as e:  # noqa: BLE001
        sys.exit("Servidor não respondeu: %s\nO container está de pé? (docker compose ps)" % e)
    print("  servidor ok")

    email = input("E-mail do app: ").strip().lower()
    senha = getpass.getpass("Senha do app (não aparece ao digitar): ")
    try:
        login = http("POST", "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + chave,
                     {"email": email, "password": senha, "returnSecureToken": True})
    except RuntimeError as e:
        sys.exit("Falha no login do Firebase: %s" % e)
    uid, token_fb = login["localId"], login["idToken"]
    print("  login ok")

    payload, esperado = {}, {}
    for col in COLS:
        payload[col] = ler_colecao(projeto, uid, col, token_fb)
        esperado[col] = len(payload[col])
        print("  Firestore %-9s %d documento(s)" % (col, esperado[col]))

    print("Enviando para o servidor ...")
    r = http("POST", srv + "/api/import", payload, h_srv)
    print("  importados:", r.get("importados"))

    print("Conferindo ...")
    export = http("GET", srv + "/api/export", headers=h_srv)
    ok = True
    for col in COLS:
        n = len(export.get(col, []))
        bom = n >= esperado[col]
        ok = ok and bom
        print("  %-9s %d no servidor (esperado %d) %s" % (col, n, esperado[col], "OK" if bom else "FALTOU"))
    print("\nPronto! Tudo foi copiado." if ok else "\nAlgo ficou faltando: rode de novo.")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
