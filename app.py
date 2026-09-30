from __future__ import annotations

import json
import logging
import secrets
import threading
import time
import uuid
from collections import Counter
from typing import Any

from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

MODOS = ("ganar", "perder", "random")
N_DADOS = 3
TTL_TIRADA_S = 120
_rng = secrets.SystemRandom()
log = logging.getLogger("tiradas")


class ApiError(Exception):
    def __init__(self, http: int, codigo: str, detalle: str):
        super().__init__(detalle)
        self.http, self.codigo, self.detalle = http, codigo, detalle


def _err(http: int, codigo: str, detalle: str):
    return jsonify({"ok": False, "error": codigo, "detalle": detalle}), http


# ───────────────────────────── reglas y generación ─────────────────────────────

def cumple_regla(modo: str, valores: list[int]) -> bool:
    if modo not in MODOS or len(valores) != N_DADOS:
        return False
    if any(type(v) is not int or not 1 <= v <= 6 for v in valores):
        return False

    if modo == "random":
        return True

    c = Counter(valores)

    if modo == "ganar":
        # 1-1-1
        if valores == [1, 1, 1]:
            return True
        # 4-5-6
        if sorted(valores) == [4, 5, 6]:
            return True
        # par de 1, 2 o 3 + suelto 4, 5 o 6
        for v, n in c.items():
            if n >= 2 and v in (1, 2, 3):
                resto = list(valores)
                resto.remove(v)
                resto.remove(v)
                if len(resto) == 1 and resto[0] in (4, 5, 6):
                    return True
        return False

    if modo == "perder":
        # exactamente un 1 y un par que no sea de 1
        if c[1] != 1:
            return False
        resto = [v for v in valores if v != 1]
        return len(resto) == 2 and resto[0] == resto[1] and resto[0] != 1

    return False


def generar_valores(modo: str) -> list[int]:
    """
    Genera valores según el modo.
    
    ⚡ MODO RANDOM: puro, criptográficamente seguro, sin patrón.
       Cada dado es independiente y usa secrets.randbelow (CSPRNG).
       Nunca se repiten semillas, nunca hay sesgo, nunca hay correlación
       entre tiradas consecutivas.
    """
    if modo == "random":
        # ⚡ RANDOM 100% PURO — 3 valores independientes sin restricción
        return [secrets.randbelow(6) + 1 for _ in range(N_DADOS)]

    if modo == "ganar":
        opciones = []
        opciones.append([1, 1, 1])
        opciones.append([4, 5, 6])
        for par in (1, 2, 3):
            for suelto in (4, 5, 6):
                opciones.append([par, par, suelto])
        valores = _rng.choice(opciones)
        _rng.shuffle(valores)
        return valores

    if modo == "perder":
        opciones = []
        for par in (2, 3, 4, 5, 6):
            opciones.append([par, par, 1])
        valores = _rng.choice(opciones)
        _rng.shuffle(valores)
        return valores

    # Fallback por si llega algo inesperado
    return [secrets.randbelow(6) + 1 for _ in range(N_DADOS)]


# ───────────────────────────── validación de entrada ─────────────────────────────

def _uuid(v: Any, campo: str) -> str:
    try:
        if isinstance(v, str) and str(uuid.UUID(v)) == v.lower():
            return v.lower()
    except ValueError:
        pass
    raise ApiError(400, "campo_invalido", f"'{campo}' debe ser un UUID canónico")


def _cuerpo_json() -> dict:
    if not request.is_json:
        raise ApiError(415, "content_type_invalido", "Content-Type debe ser application/json")
    datos = request.get_json(silent=True)
    if not isinstance(datos, dict):
        raise ApiError(400, "json_invalido", "el cuerpo debe ser un objeto JSON válido")
    return datos


def _valores(v: Any, campo: str) -> list[int]:
    if (not isinstance(v, list) or len(v) != N_DADOS
            or any(type(x) is not int or not 1 <= x <= 6 for x in v)):
        raise ApiError(400, "campo_invalido", f"'{campo}' debe ser una lista de {N_DADOS} enteros 1..6")
    return v


# ───────────────────────────── aplicación ─────────────────────────────

def create_app(guion: tuple[str, ...] = ("random",), ttl_s: float = TTL_TIRADA_S) -> Flask:
    if not guion or any(m not in MODOS for m in guion):
        raise ValueError("guion inválido")
    app = Flask(__name__)
    lock = threading.Lock()
    tiradas: dict[str, dict] = {}
    solicitudes: dict[tuple[str, str], str] = {}
    progreso: dict[str, int] = {}
    incidentes: list[dict] = []
    estado_guion = {"guion": tuple(guion)}
    app.extensions["tiradas"] = {
        "incidentes": incidentes,
        "tiradas": tiradas,
        "progreso": progreso,
        "estado_guion": estado_guion,
    }

    def incidente(t: dict, tipo: str, mostrados: list[int]) -> None:
        t["estado"] = "incidente"
        reg = {
            "tipo": tipo,
            "id_tirada": t["id"],
            "sesion": t["sesion"],
            "modo": t["modo"],
            "entregados": t["valores"],
            "mostrados": mostrados,
            "ts": time.time(),
        }
        incidentes.append(reg)
        log.error("INCIDENTE %s", json.dumps(reg))

    def caducar(ahora: float) -> None:
        for t in tiradas.values():
            if t["estado"] == "emitida" and ahora - t["creada"] > ttl_s:
                t["estado"] = "expirada"

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/control")
    def control():
        return render_template("control.html")

    @app.get("/api/estado")
    def api_estado():
        with lock:
            ultimo = incidentes[-1] if incidentes else None
            return jsonify({
                "ok": True,
                "sesiones": list(progreso.keys()),
                "progreso": dict(progreso),
                "tiradas_activas": sum(1 for t in tiradas.values() if t["estado"] == "emitida"),
                "total_tiradas": len(tiradas),
                "incidentes": len(incidentes),
                "ultimo_incidente": ultimo,
                "guion": list(estado_guion["guion"]),
            })

    @app.post("/api/v1/guion")
    def cambiar_guion():
        d = _cuerpo_json()
        nuevo = d.get("guion")
        if not isinstance(nuevo, list) or not nuevo:
            raise ApiError(400, "guion_invalido", "el guion debe ser una lista no vacía")
        if any(m not in MODOS for m in nuevo):
            raise ApiError(400, "guion_invalido", f"modos permitidos: {MODOS}")
        with lock:
            estado_guion["guion"] = tuple(nuevo)
            if d.get("reset", False):
                progreso.clear()
                tiradas.clear()
                solicitudes.clear()
        return jsonify({"ok": True, "guion": nuevo})

    @app.post("/api/v1/tirada")
    def solicitar_tirada():
        d = _cuerpo_json()
        sesion = _uuid(d.get("sesion_id"), "sesion_id")
        solicitud = _uuid(d.get("solicitud_id"), "solicitud_id")
        ahora = time.monotonic()
        with lock:
            caducar(ahora)
            previa = solicitudes.get((sesion, solicitud))
            if previa is not None:
                t = tiradas[previa]
                if t["estado"] != "emitida":
                    raise ApiError(409, "solicitud_consumida", f"la solicitud ya terminó en estado '{t['estado']}'")
                return jsonify(_ok_tirada(t))
            guion_actual = estado_guion["guion"]
            paso = progreso.get(sesion, 0) % len(guion_actual)
            for t in tiradas.values():
                if t["sesion"] == sesion and t["estado"] == "emitida":
                    t["estado"] = "abandonada"
            modo = guion_actual[paso]
            valores = generar_valores(modo)
            if not cumple_regla(modo, valores):
                log.critical("regla interna violada modo=%s valores=%s", modo, valores)
                raise ApiError(500, "regla_interna_violada", "el generador produjo valores fuera de regla")
            t = {
                "id": str(uuid.uuid4()),
                "sesion": sesion,
                "modo": modo,
                "valores": valores,
                "estado": "emitida",
                "creada": ahora,
            }
            tiradas[t["id"]] = t
            solicitudes[(sesion, solicitud)] = t["id"]
            return jsonify(_ok_tirada(t))

    @app.post("/api/v1/tirada/resultado")
    def registrar_resultado():
        d = _cuerpo_json()
        id_t = _uuid(d.get("id_tirada"), "id_tirada")
        mostrados = _valores(d.get("valores_mostrados"), "valores_mostrados")
        with lock:
            caducar(time.monotonic())
            t = tiradas.get(id_t)
            if t is None:
                raise ApiError(404, "tirada_desconocida", "no existe esa tirada")
            est = t["estado"]
            if est == "expirada":
                raise ApiError(410, "tirada_expirada", "la tirada caducó antes de registrarse")
            if est == "abandonada":
                raise ApiError(409, "tirada_abandonada", "la tirada fue sustituida por una solicitud posterior")
            if est == "incidente":
                raise ApiError(409, "tirada_en_incidente", "la tirada ya está marcada como incidente")
            if mostrados != t["valores"]:
                incidente(t, "valores_no_coinciden", mostrados)
                raise ApiError(409, "valores_no_coinciden", "los valores mostrados no coinciden con los entregados")
            if not cumple_regla(t["modo"], mostrados):
                incidente(t, "regla_incumplida", mostrados)
                raise ApiError(422, "regla_incumplida", f"los valores no cumplen la regla del modo '{t['modo']}'")
            if est == "emitida":
                t["estado"] = "registrada"
                progreso[t["sesion"]] = progreso.get(t["sesion"], 0) + 1
            return jsonify({
                "ok": True,
                "id_tirada": t["id"],
                "modo": t["modo"],
                "valores_registrados": t["valores"],
            })

    @app.errorhandler(ApiError)
    def _h_api(e: ApiError):
        return _err(e.http, e.codigo, e.detalle)

    @app.errorhandler(HTTPException)
    def _h_http(e: HTTPException):
        mapa = {404: "ruta_no_encontrada", 405: "metodo_no_permitido", 413: "cuerpo_demasiado_grande"}
        return _err(e.code or 500, mapa.get(e.code or 500, "error_http"), e.description or "error HTTP")

    @app.errorhandler(Exception)
    def _h_fatal(e: Exception):
        log.exception("error no controlado")
        return _err(500, "error_interno", "error interno del servidor")

    app.config["MAX_CONTENT_LENGTH"] = 4096
    return app


def _ok_tirada(t: dict) -> dict:
    return {"ok": True, "valores": t["valores"], "modo": t["modo"], "id_tirada": t["id"]}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    create_app().run(host="0.0.0.0", port=5000, debug=True)