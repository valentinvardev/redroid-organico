# **1. Resumen del Sistema**

El presente documento describe la arquitectura de un sistema automatizado para la publicación masiva de contenido en redes sociales (TikTok, Facebook, Instagram) diseñado para operar sin detección algorítmica (*shadowbans*).

El sistema abandona las APIs oficiales restrictivas y la emulación x86, adoptando un enfoque de **Android Nativo en la Nube (ReDroid)** sobre servidores ARM, combinado con aislamiento estricto de proxies residenciales a nivel de contenedor y orquestación asíncrona en TypeScript.

# **2. Stack Tecnológico y Componentes**

| **Capa** | **Tecnología** | **Función Principal** |
| --- | --- | --- |
| **Aplicación Web** | Next.js, tRPC, React | Panel de control para subir videos y definir redes objetivo. |
| **Base de Datos** | Prisma (PostgreSQL / Supabase) | Almacenamiento de credenciales de proxy, cuentas de RRSS y rutas de volúmenes. |
| **Orquestación** | BullMQ + Redis | Gestión de colas, control de concurrencia y reintentos automáticos. |
| **Infraestructura** | Servidores ARM (ej. AWS Graviton) | Ejecución nativa de contenedores Android sin penalización de CPU. |
| **Emulación SO** | ReDroid (Android 11) | Contenedor headless de Android con soporte de renderizado en memoria. |
| **Aislamiento** | tun2socks + Docker Networks | Enrutamiento forzado del tráfico de cada contenedor hacia su proxy específico. |
| **Automatización** | Appium + ADB (Node.js) | Interacción con la UI de las aplicaciones simulando toques humanos y transferencia de archivos. |

# **3. Arquitectura de Contenedores y Red**

Para garantizar que los algoritmos de detección no vinculen las cuentas, la aplicación de cada red social opera dentro de una infraestructura aislada dinámicamente.

**El Patrón de Aislamiento (Network Namespace Sharing)**

No se configuran proxies dentro del sistema operativo Android. En su lugar, se despliega un contenedor "Router" (tun2socks) que maneja la autenticación del proxy residencial. El contenedor de ReDroid se fusiona a la interfaz de red de este enrutador, garantizando que el 100% del tráfico salga enmascarado.

**Plantilla Base (docker-compose.yml):**

version: '3.8'

services:

# Contenedor 1: Enrutador Proxy

proxy_gateway_cuenta1:

image: xjasonlyu/tun2socks:v2.5.1

cap_add:

- NET_ADMIN

devices:

- /dev/net/tun

environment:

- PROXY=http://usuario:password@ip_proxy:puerto

- LOGLEVEL=info

ports:

- "5555:5555" # Puerto ADB expuesto aquí

# Contenedor 2: Teléfono Android Descartable

redroid_cuenta1:

image: mi_redroid_base # Imagen maestra con TikTok/Meta preinstalado

privileged: true

network_mode: "service:proxy_gateway_cuenta1" # Aislamiento forzado

volumes:

- /rutas/servidor/sesiones/cuenta_1:/data # Persistencia de sesión

depends_on:

- proxy_gateway_cuenta1

# **4. Ciclo de Vida de Publicación (Flujo del Sistema)**

El proceso de subida se desacopla del hilo principal del servidor para evitar *timeouts* y gestionar los recursos de forma controlada.

**Fase 1: Encolamiento (Productor)**

1. El usuario desencadena la subida de una campaña desde la interfaz de Next.js.
2. El servidor guarda los metadatos a través de Prisma y deposita un trabajo en BullMQ ({ videoId, accountId }).
3. La interfaz web responde inmediatamente como "Procesando".

**Fase 2: Preparación (Worker)**

1. Un *Worker* de BullMQ toma el trabajo y consulta las credenciales en la base de datos.
2. El sistema ejecuta comandos de Docker para levantar el entorno efímero basado en la plantilla docker-compose, mapeando el volumen de sesión correspondiente.

**Fase 3: Inyección de Multimedia (ADB)**

1. Antes de abrir la red social, el Worker transfiere el archivo MP4 al entorno de Android y fuerza la actualización de la base de datos de medios.

import { exec } from 'child_process';

import { promisify } from 'util';

const execAsync = promisify(exec);

async function prepararVideo(rutaArchivo: string, ip: string) {

// Transferir al almacenamiento interno

await execAsync(`adb -s ${ip} push "${rutaArchivo}" "/sdcard/DCIM/video.mp4"`);

// Forzar escaneo (Media Store) para visibilidad inmediata en la galería

await execAsync(`adb -s ${ip} shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/DCIM/video.mp4`);

}

**Fase 4: Automatización de UI (Appium)**

1. El Worker inicia una sesión de WebDriver hacia el puerto 5555.
2. Se ejecutan instrucciones precisas para abrir la aplicación (ej. com.zhiliaoapp.musically), localizar selectores XML estables (evitando IDs ofuscados), escribir la descripción y publicar.
3. Se introducen retrasos aleatorios (jitter) entre clics para emular cadencia humana.

**Fase 5: Limpieza (Teardown)**

1. Se elimina el archivo de video local dentro del contenedor Android (adb shell rm /sdcard/DCIM/video.mp4) para preservar espacio.
2. El Worker destruye los contenedores de Docker. Los datos de sesión (cookies, login) permanecen seguros en el almacenamiento persistente del servidor para la siguiente ejecución.

# **5. Prevención de Riesgos Críticos**

- **Detección de Hardware Simulado:** Se mitiga al ejecutar Android sobre arquitectura ARM nativa (AWS Graviton), eliminando las banderas rojas de la traducción x86 (librerías houdini).
- **Contaminación Cruzada:** Estrictamente evitada mediante volúmenes de Docker independientes por cada perfil de red social. Nunca se cruzan cuentas en un mismo entorno de datos.
- **Bloqueo de IPs (Shadowbans):** Eliminado al prescindir de IPs de Datacenter. El enrutamiento obliga al tráfico de la capa 7 a resolver exclusivamente mediante IPs Residenciales o conexiones Móviles 4G/5G compartidas.
