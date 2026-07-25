# Servicios

Unidades systemd para dejar el panel y el worker corriendo sin una terminal
abierta. Los datastores, Appium y ws-scrcpy siguen en compose.

## Instalar

Asumen `/home/ubuntu/redroid-organico` y usuario `ubuntu`. Si tu ruta difiere,
editá `WorkingDirectory` y `User` antes de copiar.

```bash
sudo cp deploy/redroid-web.service deploy/redroid-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now redroid-web redroid-worker
```

Antes conviene matar lo que quedó corriendo a mano, o los puertos van a estar
ocupados:

```bash
pkill -9 -f 'next-server'; pkill -9 -f 'next dev'; pkill -9 -f 'tsx worker'
```

## Operar

```bash
systemctl status redroid-web redroid-worker
journalctl -u redroid-worker -f          # logs en vivo
journalctl -u redroid-worker -n 200      # las ultimas 200 lineas
sudo systemctl restart redroid-worker    # despues de un git pull
```

**Reiniciá el worker despues de cada `git pull`**: `tsx` no recarga en caliente,
asi que un proceso viejo sigue ejecutando el codigo anterior. El panel sí
recompila solo en modo dev.

## Que hace el compose y que hace systemd

| Pieza | Donde |
| --- | --- |
| Postgres, Redis | compose |
| adb server, Appium, ws-scrcpy | compose, perfil `android` |
| Contenedores ReDroid | los crea el worker por job |
| Panel, worker | systemd |

Los dos primeros arrancan solos con `restart: unless-stopped`. Para que compose
levante al reiniciar la instancia:

```bash
cd ~/redroid-organico && docker compose --profile android up -d
```

Docker recuerda los contenedores entre reboots mientras no les hagas `down`.

## Por que no el worker adentro de compose

El compose ya define servicios `web` y `worker`, y usarlos daria reinicio
automatico sin systemd. Pero el worker en un contenedor no ve el filesystem del
host, y hoy `apkPath` apunta a un APK que vive ahi. Migrarlo requiere montar ese
directorio y reapuntar `adbHost` al nombre del servicio. Es el camino correcto
para produccion; systemd es el que no cambia nada de lo que ya funciona.

## Sobre el modo dev

Las unidades corren `npm run dev`. En una instancia expuesta eso importa por dos
razones: el atajo de sesion de `lib/auth/session.ts` esta activo con
`NODE_ENV=development`, asi que **el panel no pide login**, y Next en dev es mas
lento y mas pesado.

Pasar a `npm run build && npm start` desactiva ese atajo — pero marca la cookie
de sesion como `secure`, que sobre HTTP plano el navegador no manda, y el login
deja de funcionar. Las dos cosas se resuelven juntas poniendo TLS adelante.
Hasta entonces, el security group cerrado a tu IP es lo que sostiene esto.
