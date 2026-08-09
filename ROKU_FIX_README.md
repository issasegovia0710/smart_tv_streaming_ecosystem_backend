# Fix Roku para canales WEB

Este paquete conecta una pieza que ya existía en el backend: `mediaGateway.js`.

## Qué cambia

`GET /api/v1/tv/channels/:id/play?refresh=1` ahora pasa las resoluciones HLS de canales `web` por `decorateResolvedMedia()`.

Cuando Playwright encuentra un HLS que requiere cookies, Referer, Origin o User-Agent, el backend devuelve una URL de esta forma:

`/api/v1/media/proxy/:token`

El proxy:

- solicita el HLS usando los headers/cookies capturados por Playwright;
- reescribe las URLs de playlists hijas, llaves y segmentos;
- conserva Range cuando Roku lo envía;
- sirve los segmentos al Roku desde el mismo backend.

## Importante

No elimina ni evita DRM. Los flujos con DRM que necesiten licencias deben usar un sistema compatible y autorizado.

## Despliegue

Conserva las variables de entorno que ya tienes en Vercel. Este ZIP no incluye `.env` ni `.env.local`.

La variable `MEDIA_PROXY_SECRET` es recomendable. Si no existe, el código actual usa `DB_PASSWORD` como fallback, pero es mejor definir una clave independiente larga.
