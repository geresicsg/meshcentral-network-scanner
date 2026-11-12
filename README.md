# MeshCentral Network Scanner 1.1.0

A kiválasztott MeshCentral agent hálózatát vizsgálja. A vizsgálat az agent gépén fut, nem a MeshCentral szerveren.

## Támogatott platformok

- Windows agent: PowerShell, MeshCentral `runcommands` type `2`.
- Linux agent: shell + Python 3 standard library, MeshCentral `runcommands` type `3`.
- A Linux oldali interfészlista az `ip` (iproute2) parancsot használja.
- Linux oldalon nincs szükség pip csomagra vagy külön telepített scannerre; Python 3 és iproute2 szükséges.

## Funkciók

- Az agent IPv4 hálózati interfészeinek listázása, automatikus tartományajánlással.
- Egyéni CIDR tartomány (például `10.151.10.0/24`) vagy kezdő-vég IP (például `10.151.10.1-10.151.10.254`) megadása.
- ICMP ping és gyakori TCP portok párhuzamos ellenőrzése Linuxon; Windows alatt ICMP és TCP portvizsgálat.
- IP-cím, reverse DNS/gépnév, MAC-cím (helyi neighbor/ARP cache alapján) és nyitott TCP portok megjelenítése.
- A találatok agentenként megmaradnak a plugin felületén, amíg az oldal újra nem töltődik.

## Vizsgált TCP portok

`21, 22, 23, 80, 443, 445, 502, 3389, 8080, 8443, 11740`

A portellenőrzés opcionális, a jelölőnégyzettel kikapcsolható. Ez nem teljes portscan, csak a felsorolt TCP portokat ellenőrzi.

## Telepítés

A MeshCentral konfigurációban legyen engedélyezve a pluginrendszer:

```json
{
  "plugins": {
    "enabled": true
  }
}
```

Ezután a MeshCentral admin felületén: **My Server → Plugins → Download plugin**, majd a `config.json` raw GitHub URL-je.

## Használat

1. Nyisd meg a Windows vagy Linux agent eszközoldalát.
2. Válaszd a **Network Scanner** fület.
3. Az interfészlista automatikusan betöltődik.
4. Válassz egy felajánlott hálózati tartományt, vagy add meg a sajátodat.
5. Indítsd el a vizsgálatot.

## Korlátok és megjegyzések

- A Linux agenten Python 3 és `ip` (iproute2) szükséges.
- Linuxon a TCP ellenőrzés a Python standard library socket funkcióját használja; nem igényel `nmap`, `nc` vagy `fping` telepítést.
- A MAC-cím csak akkor jelenik meg, ha az agent neighbor/ARP táblájában elérhető.
- Routeren túli eszközöknél a MAC-cím általában nem kérdezhető le.
- Linuxon az ICMP-t tiltó eszközök is megjelenhetnek, ha valamelyik vizsgált TCP portjuk nyitott. Windows alatt az első verzió a TCP portokat a pingre válaszoló címeken ellenőrzi.
- Legfeljebb 4094 címet vizsgál. Nagyobb hálózatokhoz kisebb alhálózatokra kell bontani.
- A Windows verzió PowerShell `Start-Job` feladatokat használ az ICMP felderítéshez, ezért nagyobb tartományoknál több erőforrást vehet igénybe.
- A MeshCentral `runcommands` jogosultság szükséges a felhasználónak.

## Biztonság

A plugin lekérdezéseket végez; nem módosít hálózati konfigurációt, nem telepít szoftvert a célgépekre. Csak olyan hálózatot vizsgálj, amelynek felderítésére jogosult vagy.


## 1.2.0 – OUI és folyamatjelző

- A MAC-cím első 24 bitje (OUI) alapján helyi gyártó-hozzárendelés jelenik meg.
- A csomag egy beépített, gyakori gyártókat tartalmazó OUI-listát használ; ez nem a teljes, naponta frissülő IEEE adatbázis. Ismeretlen prefix esetén „Ismeretlen OUI” látszik.
- A keresés 128 címes blokkokra van bontva. Minden blokk befejezésekor frissül a százalékos folyamatjelző és a találatok száma.
- A részletekre bontás miatt a keresés közben a felület tényleges előrehaladást tud mutatni.
