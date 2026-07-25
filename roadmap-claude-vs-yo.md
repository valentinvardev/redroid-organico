# Roadmap de implementación — Claude vs. trabajo directo

## 1. Objetivo

Separar claramente lo que Claude puede ayudar a definir o revisar, y lo que yo debo implementar directamente en este proyecto para avanzar hacia el sistema de prueba y automatización de mi propia app.

## 2. Principio general

Este roadmap no reemplaza el proyecto ni lo reinventa desde cero. Lo que se busca es evolucionar la base actual paso a paso, en fases, sin perder el objetivo del MVP inicial.

## 3. Fase M0 — Sanear la base

### Objetivo
- dejar el proyecto estable
- quitar el worker falso que hoy vive dentro de la app
- evitar que la arquitectura actual se vuelva un obstáculo para las fases siguientes

### Lo que yo voy a hacer
- desactivar o limpiar el worker falso de lib/queue.ts
- dejar la API HTTP estable para jobs
- eliminar lógica de queue improvisada que ya no encaja con el roadmap
- asegurar que el front siga funcionando aunque la infraestructura aún no esté completa
- limpiar el uso de archivos huérfanos y unificar el path de almacenamiento

### Lo que Claude puede ayudar con
- revisar si la arquitectura inicial es suficientemente limpia para pasar a la siguiente fase
- proponer mejoras menores de organización

## 4. Fase M1 — Persistencia real

### Objetivo
- reemplazar el almacenamiento actual basado en JSON por una persistencia real
- preparar la base del sistema para crecer sin carrera de writes ni corrupción de estado

### Lo que yo voy a hacer
- instalar Prisma
- configurar PostgreSQL
- definir los modelos iniciales:
  - users
  - accounts
  - videos
  - jobs
  - job_logs
- crear migraciones versionadas
- agregar índices en jobs.status y jobs.accountId

### Lo que Claude puede ayudar con
- revisar el diseño del schema
- sugerir relaciones, constraints y nombres de campos
- proponer estrategia de índices y capacidad de escalado

## 5. Fase M2 — Colas de verdad

### Objetivo
- dejar de depender del worker dentro de Next.js
- convertir el procesamiento en un proceso independiente

### Lo que yo voy a hacer
- preparar el proyecto para que el worker sea un proceso separado
- implementar el worker mínimo con la lógica de procesamiento
- asegurar que los jobs no queden colgados en processing si el proceso se reinicia
- implementar graceful shutdown y recuperación básica

### Lo que Claude puede ayudar con
- diseñar la arquitectura de BullMQ + Redis
- proponer reintentos, dead-letter queues y recovery de jobs huérfanos

## 6. Fase M3 — Pipeline de media

### Objetivo
- que el sistema acepte videos reales y no solo caption + account

### Lo que yo voy a hacer
- implementar upload multipart
- preparar almacenamiento local inicial o S3/R2
- validar formato, tamaño, duración y aspect ratio
- preparar la estructura para transcoding y thumbnail

### Lo que Claude puede ayudar con
- definir políticas de validación de media
- recomendar reglas de ffmpeg y estándares de calidad

## 7. Fase M4 — Confiabilidad

### Objetivo
- evitar duplicación de publicaciones y fallos repetitivos

### Lo que yo voy a hacer
- implementar idempotency key por job
- agregar reintentos básicos
- manejar timeouts y estados de error
- preparar la base para backoff exponencial y límite de intentos

### Lo que Claude puede ayudar con
- proponer la política exacta de retry y backoff
- definir la estrategia de DLQ y rate limiting por cuenta

## 8. Fase M5 — Estado y observabilidad

### Objetivo
- que el sistema tenga trazabilidad de cada publicación

### Lo que yo voy a hacer
- implementar job_logs con niveles
- guardar timeline de eventos por job
- exponer el estado al panel
- preparar polling o SSE para actualizar la UI

### Lo que Claude puede ayudar con
- proponer la mejor UX para logs y timeline
- sugerir métricas útiles de éxito y fallo por cuenta

## 9. Fase M6 — Panel usable

### Objetivo
- dejar de tener un simple formulario y convertirlo en un dashboard real

### Lo que yo voy a hacer
- reemplazar app/page.tsx por una vista de dashboard
- mostrar cola en vivo
- mostrar historial de jobs
- mostrar detalle de cada job con logs
- integrar gestión básica de cuentas
- preparar el soporte para scheduling o publicación futura

### Lo que Claude puede ayudar con
- proponer la estructura visual del panel
- ayudar a ordenar la UX y la jerarquía de información

## 10. Fase M7 — Producción

### Objetivo
- dejar el proyecto listo para correr en un entorno más realista

### Lo que yo voy a hacer
- preparar Dockerfiles
- crear docker-compose con Postgres y Redis
- agregar healthchecks básicos
- mover secretos fuera del repo
- preparar migraciones en el arranque

### Lo que Claude puede ayudar con
- revisar seguridad y recomendaciones de despliegue
- ayudar con CI y observabilidad de producción

## 11. Qué voy a hacer yo directamente

Lo que voy a implementar yo en este workspace:
- código real
- endpoints
- servicios
- UI
- integraciones básicas
- estructura del proyecto
- configuración inicial del stack

## 12. Qué va a hacer Claude

Lo que Claude puede hacer mejor:
- definir arquitectura
- sugerir patrones y estrategia
- revisar decisiones técnicas
- proponer mejoras de diseño
- ayudar con la orientación general del proyecto

## 13. Orden recomendado de ejecución

1. M0 — limpiar la base
2. M1 — Prisma + PostgreSQL
3. M2 — BullMQ + Redis
4. M3 — upload y media pipeline
5. M4 — confiabilidad
6. M5 — logs y observabilidad
7. M6 — dashboard
8. M7 — producción

## 14. Conclusión

El proyecto sí va a cambiar, pero de forma progresiva y ordenada. El trabajo de Claude será guiar el diseño y la estrategia, mientras yo voy a implementar la ejecución real del proyecto en el repo.
