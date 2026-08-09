# Roku / Vercel ETXTBSY fix

Corrige el error intermitente:

`browserType.launch: spawn ETXTBSY`

## Qué cambió

Solo se modificó `src/services/browserStreamResolver.js`.

- Se comparte una única promesa de extracción de Chromium por proceso y URL de pack.
- Las solicitudes concurrentes esperan la misma extracción en vez de escribir `/tmp/chromium` simultáneamente.
- Si `browserType.launch()` recibe `ETXTBSY`, se reintenta con esperas cortas.
- No se cambiaron endpoints, catálogo, base de datos, mediaGateway ni la lógica Roku.

## Despliegue

Mantén las mismas variables de entorno de Vercel. Este paquete no contiene `.env` ni `.env.local`.
