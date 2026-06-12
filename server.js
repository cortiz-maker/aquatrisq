// ============================================================
// AQUATRISQ — Puente DispatchTrack
// Express en Railway. Hace de intermediario entre el formulario
// de pedidos (React/Supabase) y DispatchTrack.
//
//   Formulario React  ──POST /api/dispatches──▶  DispatchTrack
//   DispatchTrack     ──POST /api/webhooks/...─▶  Supabase (entregas)
//
// Variables de entorno (se configuran en Railway → Variables):
//   DISPATCHTRACK_API_KEY   llave creada en DispatchTrack (pantalla "Llaves API")
//   DT_API_URL              URL base del API de tu cuenta DispatchTrack
//   SUPABASE_URL            https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY    service_role key (SOLO aquí, nunca en el frontend)
//   PUENTE_TOKEN            (opcional) token simple para que solo tu app llame /api/dispatches
// ============================================================

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());

const DT_API_URL = process.env.DT_API_URL || "";
const DT_API_KEY = process.env.DISPATCHTRACK_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const PUENTE_TOKEN = process.env.PUENTE_TOKEN || "";
const PORT = process.env.PORT || 3000;

// Cliente Supabase (solo si están las variables). Service key => escribe sin RLS.
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// ── Healthcheck ──────────────────────────────────────────────
// Úsalo para confirmar que Railway levantó bien: GET /health
app.get("/health", (req, res) =>
  res.json({
    status: "ok",
    service: "aquatrisq-bridge",
    dispatchtrack: DT_API_KEY ? "configurado" : "falta DISPATCHTRACK_API_KEY",
    supabase: supabase ? "conectado" : "falta SUPABASE_URL/SERVICE_KEY",
  })
);

// ── Guard simple para endpoints que escriben ─────────────────
// Si defines PUENTE_TOKEN, tu formulario debe mandar header
// "x-puente-token". Si no lo defines, queda abierto (dev).
function checkPuenteToken(req, res, next) {
  if (!PUENTE_TOKEN) return next();
  if (req.get("x-puente-token") === PUENTE_TOKEN) return next();
  return res.status(401).json({ error: "Token de puente inválido." });
}

function checkDispatchTrack(req, res, next) {
  if (!DT_API_KEY || !DT_API_URL) {
    return res
      .status(500)
      .json({ error: "Falta DISPATCHTRACK_API_KEY o DT_API_URL en el servidor." });
  }
  next();
}

// ── Headers hacia DispatchTrack ──────────────────────────────
// OJO: el formato exacto (Token / Bearer / header propio) se
// confirma con la doc de tu cuenta. Dejo "Token" como en Quantrex.
function dtHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Token ${DT_API_KEY}`,
  };
}

// ── POST /api/dispatches — crear pedido en DispatchTrack ─────
// El formulario React llama aquí al confirmar un pedido.
// Body esperado: { pedido: { ...campos del pedido Aquatrisq } }
app.post("/api/dispatches", checkPuenteToken, checkDispatchTrack, async (req, res) => {
  const { pedido } = req.body;
  if (!pedido) return res.status(400).json({ error: "Se requiere el campo 'pedido'." });

  // ──────────────────────────────────────────────────────────
  // TODO (pendiente de la doc de DispatchTrack):
  // Mapear 'pedido' al payload de Create Dispatch. Borrador según
  // el análisis del Excel Cliente_ID — AJUSTAR con la doc real:
  //
  // const payload = {
  //   identifier:     pedido.numero_guia,        // tu AQ-00001 / Nº guía
  //   contact_id:     pedido.cliente_id,
  //   contact_name:   pedido.contacto_nombre,
  //   contact_phone:  pedido.telefono,
  //   contact_email:  pedido.email,
  //   address:        pedido.direccion,
  //   latitude:       pedido.latitud,
  //   longitude:      pedido.longitud,
  //   min_delivery_time: pedido.fecha_min,
  //   max_delivery_time: pedido.fecha_max,
  //   items: pedido.items,                        // [{ name, quantity, code, price }]
  //   tags:  [pedido.ruta, pedido.tipo_pago],     // TrisQ/Positive/AguaFine, factura/boleta
  // };
  //
  // const { data } = await axios.post(
  //   `${DT_API_URL}/dispatches`, payload, { headers: dtHeaders() }
  // );
  // return res.json({ ok: true, dispatchtrack: data });
  // ──────────────────────────────────────────────────────────

  return res.status(501).json({
    error: "Mapeo DispatchTrack pendiente de la documentación del API.",
    recibido: pedido,
  });
});

// ── POST /api/webhooks/dispatchtrack — entrega completada ────
// DispatchTrack llama aquí (lo configuras en su panel de Webhooks,
// apuntando a https://TU-URL.up.railway.app/api/webhooks/dispatchtrack)
app.post("/api/webhooks/dispatchtrack", async (req, res) => {
  const evento = req.body;
  console.log("📦 Webhook DispatchTrack:", JSON.stringify(evento, null, 2));

  // Guardamos el evento crudo primero (a prueba de cambios de esquema).
  // Requiere una tabla de staging en Supabase:
  //   create table if not exists dt_webhook_events (
  //     id bigint generated always as identity primary key,
  //     payload jsonb not null,
  //     recibido_en timestamptz not null default now(),
  //     procesado boolean not null default false
  //   );
  if (supabase) {
    try {
      const { error } = await supabase
        .from("dt_webhook_events")
        .insert({ payload: evento });
      if (error) console.error("Error guardando webhook en Supabase:", error.message);
    } catch (e) {
      console.error("Excepción guardando webhook:", e.message);
    }
  }

  // TODO: una vez confirmado el payload del webhook y el esquema de
  // 'entregas', mapear evento → upsert en la tabla entregas.

  // Responder 200 rápido es importante: DispatchTrack reintenta si no.
  return res.json({ received: true });
});

app.listen(PORT, () => console.log(`✅ Aquatrisq bridge escuchando en puerto ${PORT}`));
