# MeshCentral Network Scanner 2.0.0

A kiválasztott MeshCentral agent hálózatát vizsgálja. A vizsgálat az agent gépén fut, nem a MeshCentral szerveren.

## Támogatott platformok

- **Windows agent**: Windows PowerShell 5.x (Windows 8 / Server 2012 vagy újabb, illetve WMF 5), `runcommands` type `2`.
- **Linux / macOS agent**: `sh` + Python 3 (csak standard library), `runcommands` type `3`. Az interfészlistához `ip` (iproute2) vagy `ifconfig` kell.

## Funkciók

- Az agent IPv4 interfészeinek listázása, tartományajánlással (a fül első megnyitásakor automatikusan, utána gombra).
- Saját tartomány: CIDR (`10.151.10.0/24`), kezdő-vég (`10.151.10.1-10.151.10.254`), rövidített vég (`10.151.10.1-254`) vagy egyetlen IP.
- Párhuzamos ICMP ping, gyakori TCP portok és reverse DNS.
- MAC-cím a neighbor/ARP táblából, gyártó (beépített, rövid OUI-lista), helyi/véletlen MAC jelölése.
- ARP-alapú észlelés: a pingre nem válaszoló (tűzfalazott) helyi gépek is megjelennek.
- Élő találatlista és folyamatjelző, Leállítás gomb, CSV export.
- Az eredmény eszközönként megmarad, amíg az oldal újra nem töltődik.

## Együttműködés más pluginekkel

A Mesh Agent egyszerre csak egy `runcommands` parancsot futtat; ha közben újabb érkezik, azt válasz nélkül eldobja. A plugin ezért a böngészőben egy közös, agentenkénti sort tart fenn, amelyen a többi plugin (pl. cfgcheck) válaszkérő (`reply: true`) parancsai is átmennek, elsőbbséggel. Így egy futó hálózatvizsgálat közben is használható a cfgcheck: a kérése a soron következő rész-vizsgálat előtt fut le.

Ha az agent mégis foglalt (például egy másik böngészőből indított parancs fut), a plugin ezt felismeri és néhányszor újrapróbálkozik.

## Vizsgált TCP portok

`21, 22, 23, 80, 443, 445, 502, 3389, 8080, 8443, 11740` — a jelölőnégyzettel kikapcsolható. Ez nem teljes portscan.

## Telepítés

A MeshCentral konfigurációban legyen engedélyezve a pluginrendszer:

```json
{ "plugins": { "enabled": true } }
```

Ezután: **My Server → Plugins → Download plugin**, majd a `config.json` raw GitHub URL-je. Frissítés után a böngészőben töltsd újra az oldalt (Ctrl+F5).

## Korlátok

- Legfeljebb 4094 cím vizsgálatonként (Windows alatt 64, Linuxon 128 címes részletekben).
- A MAC-cím és az ARP-alapú észlelés csak az agent saját alhálózatában működik.
- A felhasználónak „Run commands” (MESHRIGHT_REMOTECOMMAND) jogosultság kell.

## Biztonság

A plugin csak lekérdez; nem módosít hálózati konfigurációt és nem telepít semmit. Csak olyan hálózatot vizsgálj, amelyre jogosult vagy.
