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
// La doc del API exige X-AUTH-TOKEN (tu API key) + Content-Type JSON.
function dtHeaders() {
  return {
    "Content-Type": "application/json",
    "X-AUTH-TOKEN": DT_API_KEY,
  };
}

// Dirección de origen de los despachos (bodega Aquatrisq).
// pickup_address.name es obligatorio en Create Dispatch.
const DT_PICKUP_NAME = process.env.DT_PICKUP_NAME || "Bodega Aquatrisq";

// ── POST /api/dispatches — crear despacho en DispatchTrack ──
// El formulario llama aquí al confirmar. Body: { pedido: {...}, items: [...] }
// El puente enriquece con cliente + domicilio desde Supabase y arma el
// payload de Create Dispatch (POST /api/external/v1/dispatches).
app.post("/api/dispatches", checkPuenteToken, checkDispatchTrack, async (req, res) => {
  const { pedido, items } = req.body;
  if (!pedido || !pedido.numero_guia) {
    return res.status(400).json({ error: "Se requiere 'pedido' con numero_guia." });
  }

  try {
    // 1) Enriquecer con cliente y domicilio (el puente usa el service key).
    let cliente = null, domicilio = null;
    if (supabase) {
      if (pedido.cliente_id) {
        const { data } = await supabase.from("clientes").select("*").eq("id", pedido.cliente_id).single();
        cliente = data || null;
      }
      if (pedido.domicilio_id) {
        const { data } = await supabase.from("domicilios").select("*").eq("id", pedido.domicilio_id).single();
        domicilio = data || null;
      }
    }

    // 2) Armar el payload de Create Dispatch.
    const direccion = domicilio
      ? [domicilio.direccion, domicilio.comuna].filter(Boolean).join(", ")
      : "";
    const lineas = Array.isArray(items) ? items : [];

    const payload = {
      identifier: pedido.numero_guia, // obligatorio (tu AQ-)
      contact_name: cliente ? cliente.nombre : (domicilio?.etiqueta || ""),
      contact_address: direccion,
      contact_phone: cliente?.telefono || "",
      contact_id: domicilio?.identificador_dt || "",          // enlaza el histórico del contacto en DispatchTrack (215-1)
      contact_identifier: domicilio?.identificador_dt || "",  // mismo valor por compatibilidad
      contact_email: cliente?.email || "",
      latitude: domicilio?.latitud ?? null,
      longitude: domicilio?.longitud ?? null,
      min_delivery_time: pedido.fecha_min_entrega || null,
      max_delivery_time: pedido.fecha_max_entrega || null,
      to_be_payed: !!pedido.por_cobrar,
      pickup_address: { name: DT_PICKUP_NAME }, // obligatorio
      items: lineas.map((l) => ({
        name: l.nombre,
        code: l.codigo || "",
        unit_price: String(l.precio_unit ?? 0),
        quantity: String(l.cantidad ?? 1),
      })),
      tags: [
        // Campos personalizados de DispatchTrack (mismos nombres que en tu cuenta).
        pedido.marca ? { name: "Ruta", value: pedido.marca, type: "string" } : null,
        pedido.tipo_documento === "factura" && pedido.rut_factura
          ? { name: "Rut_Factura", value: pedido.rut_factura, type: "string" }
          : null,
        pedido.tipo_pago ? { name: "Tipo de Pago", value: pedido.tipo_pago, type: "string" } : null,
        pedido.observacion ? { name: "Observacion Adicional", value: pedido.observacion, type: "string" } : null,
        pedido.nro_jumpseller ? { name: "N° pedido Jumpsellet", value: pedido.nro_jumpseller, type: "string" } : null,
        // N° Boleta y Chofer se completan después (facturación / asignación de ruta),
        // por eso no se envían al crear.
      ].filter(Boolean),
    };

    // 3) Crear en DispatchTrack.
    const r = await axios.post(`${DT_API_URL}/dispatches`, payload, { headers: dtHeaders() });
    return res.json({ ok: true, dispatchtrack: r.data });
  } catch (err) {
    const detalle = err?.response?.data || err.message;
    console.error("Error creando dispatch:", JSON.stringify(detalle));
    return res.status(502).json({ error: "DispatchTrack rechazó el despacho.", detalle });
  }
});

// ── POST /api/webhooks/dispatchtrack — entrega completada ────
// DispatchTrack llama aquí (lo configuras en su panel de Webhooks,
// apuntando a https://TU-URL.up.railway.app/api/webhooks/dispatchtrack)
// Codes ESTABLES del formulario del chofer en la cuenta AquaTrisQ (1048).
// Se mapea por 'code' y no por 'name' porque el nombre visible se puede
// editar en DispatchTrack, pero el code no cambia.
const EVAL_CODES = {
  "e4f74c90-f488-0135-4011-0a26a16705c2": "recibido_por",       // Nombre Quien Recibe
  "64841630-15f9-0136-4c19-02dc6ac23cb4": "pago",               // Pago (Sí/No)
  "33d5ac50-15f9-0136-4c1b-02dc6ac23cb4": "medio_pago",         // Medio Pago
  "a2c18500-9837-0136-db3b-06fba2ec54bc": "tipo_documento",     // Tipo de Documento
  "8472bc60-1850-0136-dc5e-068cd02360c0": "monto_venta",        // Monto Venta
  "2120ca70-9838-0136-24c3-068cd02360c0": "bidon_pendiente",    // Bidón Pendiente de Entrega
};

// Parsea evaluation_answers[] -> objeto con campos limpios por code.
function parseEvaluations(answers) {
  const out = {};
  if (!Array.isArray(answers)) return out;
  for (const a of answers) {
    const campo = EVAL_CODES[a.code];
    if (campo) out[campo] = a.value;
  }
  return out;
}

// Busca el valor de un tag por su name (Chofer, Ruta, ...).
function getTag(tags, name) {
  if (!Array.isArray(tags)) return null;
  const t = tags.find((x) => x.name === name);
  return t ? t.value : null;
}

function aBooleano(v) {
  if (v == null) return null;
  return ["sí", "si", "yes", "true", "1"].includes(String(v).trim().toLowerCase());
}

function aNumero(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

app.post("/api/webhooks/dispatchtrack", async (req, res) => {
  const evento = req.body;
  console.log("📦 Webhook DispatchTrack:", JSON.stringify(evento, null, 2));

  // 1) Log crudo, a prueba de todo (ver SQL de dt_webhook_events).
  if (supabase) {
    try {
      const { error } = await supabase.from("dt_webhook_events").insert({ payload: evento });
      if (error) console.error("Error guardando evento crudo:", error.message);
    } catch (e) {
      console.error("Excepción guardando evento crudo:", e.message);
    }
  }

  // 2) Versión normalizada en dt_entregas (solo despachos).
  if (supabase && evento && evento.resource === "dispatch" && evento.dispatch_id) {
    const ev = parseEvaluations(evento.evaluation_answers);
    const wp = evento.waypoint || {};

    const registro = {
      dispatch_id: evento.dispatch_id,
      guide: evento.guide || evento.identifier || null,
      account_id: evento.account_id || null,
      status: evento.status ?? null,
      substatus: evento.substatus || null,
      truck_identifier: evento.truck_identifier || null,
      chofer: getTag(evento.tags, "Chofer"),
      ruta: getTag(evento.tags, "Ruta"),
      contact_identifier: evento.contact_identifier || null,
      contact_name: evento.contact_name || null,
      contact_phone: evento.contact_phone || null,
      contact_email: evento.contact_email || null,
      contact_address: evento.contact_address || null,
      recibido_por: ev.recibido_por || null,
      pago: aBooleano(ev.pago),
      medio_pago: ev.medio_pago || null,
      tipo_documento: ev.tipo_documento || null,
      monto_venta: aNumero(ev.monto_venta),
      bidon_pendiente: aNumero(ev.bidon_pendiente),
      items: evento.items || [],
      latitude: wp.latitude || evento.management_latitude || null,
      longitude: wp.longitude || evento.management_longitude || null,
      arrived_at: evento.arrived_at || null,
      gestionado_en: evento.time_of_management || null,
      raw: evento,
      actualizado_en: new Date().toISOString(),
    };

    try {
      const { error } = await supabase
        .from("dt_entregas")
        .upsert(registro, { onConflict: "dispatch_id" });
      if (error) console.error("Error en upsert dt_entregas:", error.message);
    } catch (e) {
      console.error("Excepción en upsert dt_entregas:", e.message);
    }
  }

  // Responder 200 rápido es importante: DispatchTrack reintenta si no.
  return res.json({ received: true });
});

app.listen(PORT, () => console.log(`✅ Aquatrisq bridge escuchando en puerto ${PORT}`));
