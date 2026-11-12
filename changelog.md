# Changelog

## 1.2.0
- MAC-cím OUI alapján gyártófelismerés beépítve (helyi ismert OUI-adatbázis).
- Folyamatjelző: a vizsgálat 128 címes részletekben fut, a kezelőfelület minden rész után frissíti a százalékot és a találatok számát.
- A részletek külön agent-parancsokként futnak, így a felület nem csak egy indeterminate forgó ikont mutat.

## 1.1.0
- Linux agent támogatás (MeshCentral runcommands type 3).
- Linux interfészfelderítés az iproute2 `ip` parancsával.
- Linux hálózati vizsgálat Python 3 standard library használatával.
- ICMP-t nem válaszoló, de vizsgált TCP porton elérhető eszközök felderítése.
- Windows és Linux agenttípus szétválasztása.

## 1.0.0
- Első Windows verzió.
