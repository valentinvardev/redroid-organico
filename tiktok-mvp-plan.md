# Plan de Desarrollo — MVP TikTok con ReDroid

## 1. Objetivo

Construir un MVP funcional para publicar videos en TikTok de forma automatizada usando un flujo asíncrono, con detección de estado, persistencia de sesión y ejecución aislada por cuenta.

## 2. Alcance inicial del MVP

### Funcionalidades incluidas
- Subida de un video desde la web
- Ingreso de caption
- Selección de una cuenta TikTok
- Encolado del trabajo para publicación
- Ejecución en segundo plano mediante worker
- Seguimiento del estado del trabajo
- Persistencia básica de sesión por cuenta

### Fuera de alcance por ahora
- Soporte para otras redes sociales
- Multi-cuenta avanzada con alta concurrencia
- Proxy residencial complejo
- Anti-detección sofisticada
- Automatización de crecimiento o engagement

### Nota sobre proxies
- Los proxies sí forman parte del diseño, pero para el MVP se manejarán de forma simple y controlada.
- La idea es asignar un proxy por cuenta o por sesión, sin introducir complejidad operativa innecesaria al inicio.
- El sistema debe poder almacenar, validar y asociar un proxy a un account para que cada ejecución use la salida de red esperada.

## 3. Arquitectura propuesta

### Frontend
- Next.js
- React
- Panel para subir video, definir caption y ver estado del trabajo

### Backend
- TypeScript
- API para crear trabajos y consultar estado
- Lógica de orquestación y manejo de eventos

### Base de datos
- PostgreSQL + Prisma
- Tablas principales:
  - users
  - accounts
  - videos
  - jobs
  - job_logs

### Colas y workers
- BullMQ + Redis
- Cada publicación será un job asíncrono
- Reintentos automáticos y logs por job

### Ejecución de Android
- Docker + ReDroid o un contenedor Android compatible
- Un entorno aislado por cuenta o sesión
- ADB para transferir archivos y controlar el dispositivo emulado

### Proxies y red
- Cada cuenta puede tener asociado un proxy o un perfil de salida de red
- El worker debe poder resolver qué proxy usar antes de ejecutar la publicación
- La arquitectura debe permitir aislamiento básico por cuenta para evitar mezclar tráfico entre sesiones
- En una primera etapa, la prioridad será: almacenamiento del proxy, asociación al account y uso consistente durante la ejecución

### Automatización de UI
- Appium + ADB
- Flujo mínimo:
  1. Iniciar entorno Android
  2. Transferir video al almacenamiento interno
  3. Abrir TikTok
  4. Iniciar carga de video
  5. Escribir caption
  6. Publicar
  7. Registrar resultado
  8. Limpiar recursos

## 4. Modelo de datos recomendado

### Tabla: accounts
- id
- name
- platform (siempre tikTok por ahora)
- status
- sessionPath
- proxyId
- proxyConfig
- createdAt
- updatedAt

### Tabla: videos
- id
- fileName
- storagePath
- mimeType
- size
- createdAt

### Tabla: jobs
- id
- videoId
- accountId
- status
- queueName
- attempts
- errorMessage
- startedAt
- completedAt
- createdAt

### Tabla: proxies
- id
- name
- host
- port
- username
- password
- protocol
- status
- createdAt
- updatedAt

### Tabla: job_logs
- id
- jobId
- message
- level
- createdAt

## 5. Flujo de publicación

### Fase 1: Creación del trabajo
1. El usuario sube un video desde la interfaz.
2. El backend guarda el video y crea un registro de job.
3. El job se envía a BullMQ.

### Fase 2: Ejecución del worker
1. El worker toma el job.
2. Lee la cuenta asignada y su configuración.
3. Inicia el entorno Android o contenedor asociado.
4. Transfiere el video al dispositivo.

### Fase 3: Automatización TikTok
1. Abre la app TikTok.
2. Navega al flujo de subida.
3. Selecciona el video transferido.
4. Inserta el caption.
5. Publica.

### Fase 4: Finalización
1. Marca el job como success o failed.
2. Registra logs relevantes.
3. Limpia archivos temporales y recursos.

## 6. Primer milestone

### Objetivo mínimo viable
- Una sola cuenta TikTok
- Un solo video por job
- Un solo worker activo
- Un flujo de publicación funcional end-to-end

## 7. Riesgos iniciales

- Cambios en la UI de TikTok
- Dificultad para localizar selectores estables
- Fallos de sesión o login
- Problemas de arranque del ambiente Android
- Limitaciones de recursos del servidor
- Fallos de configuración del proxy
- Mezcla de tráfico entre sesiones si el aislamiento no es correcto

## 8. Plan de implementación por fases

### Fase 1 — Base del sistema
- Crear proyecto Next.js + TypeScript
- Configurar Prisma y PostgreSQL
- Crear modelos básicos
- Configurar BullMQ + Redis

### Fase 2 — API y jobs
- Endpoint para crear un job
- Endpoint para consultar estado del job
- Worker básico que procese jobs

### Fase 3 — Integración con Android
- Preparar contenedor Android
- Conectar por ADB
- Transferir video al dispositivo
- Validar apertura de TikTok
- Integrar la selección del proxy asociado a la cuenta

### Fase 4 — Automatización
- Implementar flujo de carga de video
- Insertar caption
- Publicar
- Manejar errores y reintentos

### Fase 5 — Producción inicial
- Logs detallados
- Limpieza automática
- Monitoreo de estado
- Manejo de fallos y recovery

## 9. Recomendación inicial

Empezar por un flujo simple y robusto, no por una arquitectura demasiado compleja. El primer objetivo debe ser demostrar que un video puede publicarse correctamente en TikTok desde un job encolado y ejecutado por un worker.
