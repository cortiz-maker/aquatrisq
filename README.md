# Aquatrisq — Puente DispatchTrack

Servicio Express que conecta el formulario de pedidos (React/Supabase)
con DispatchTrack.

- `POST /api/dispatches` — crea un pedido en DispatchTrack (lo llama el formulario).
- `POST /api/webhooks/dispatchtrack` — recibe la entrega completada y la guarda en Supabase.
- `GET /health` — chequeo de estado.

## Despliegue en Railway

1. Sube estos archivos al repo de GitHub `aquatrisq`.
2. En Railway: **New Project → Deploy from GitHub repo → aquatrisq**.
   Railway detecta Node, corre `npm install` y `npm start` solo.
3. Genera el dominio público: **Settings → Networking → Generate Domain**.
   Quedará algo como `aquatrisq-production.up.railway.app`.
4. En **Variables**, carga las del archivo `.env.example` con tus valores reales.
5. Verifica abriendo `https://TU-DOMINIO.up.railway.app/health`.

## Variables de entorno

Ver `.env.example`. La `SUPABASE_SERVICE_KEY` vive SOLO aquí, nunca en el frontend.

## Pendiente

El mapeo exacto a DispatchTrack (autenticación + payload de Create Dispatch
y del webhook) se completa con la documentación del API de la cuenta.
