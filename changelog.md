# Changelog

## 2.0.1
- A fül saját görgetősávot kap: a MeshCentral eszközpanelje levágta a hosszú találati listát. A magasság az ablakhoz igazodik (átméretezéskor is).

## 2.0.0
Teljes újraírás. A korábbi verzió nem működött, és a mellette használt pluginokat (pl. cfgcheck) is elrontotta.

Javított hibák:
- A `releaseRunCommand` és az OUI-tábla nem volt exportálva a böngészőnek, ezért minden agentválasz feldolgozása kivétellel leállt: az interfészlista nem töltődött be, a vizsgálat 0%-on állt.
- A plugin az eszközoldal minden megnyitásakor és frissítésekor magától `runcommands` kérést küldött az agentnek. Az agent egyszerre csak egy parancsot futtat, a többit szó nélkül eldobja („already busy”), ezért a cfgcheck kérései időtúllépéssel elbuktak.
- A Windows PowerShell scriptek többsoros utasításokat tartalmaztak, amit az agent stdin-alapú (`-command -`) futtatása nem kezel megbízhatóan.

Új működés:
- Közös, agentenkénti parancssor a böngészőben: a saját kérések ÉS a többi plugin válaszkérő (`reply: true`) `runcommands` kérései is ezen mennek át, így nem ütik ki egymást. A más pluginek kérései elsőbbséget kapnak.
- „Agent foglalt” felismerése és automatikus újrapróbálás (pl. ha egy másik böngészőből indított parancs fut).
- Az eszközfrissítéskor nem megy parancs az agentnek; az interfészek csak a fül megnyitásakor (eszközönként egyszer) vagy gombra kérdeződnek le.
- Az állapot (interfészek, futó vizsgálat, eredmény) eszközönként megmarad, a MeshCentral fül-újraépítései nem szakítják meg a vizsgálatot.
- Windows: a script base64-ben, rövid önálló sorokban megy át, párhuzamos ICMP + TCP + reverse DNS, MAC és ARP-alapú észlelés (a pingre nem válaszoló helyi gépek is látszanak).
- Linux/macOS: Python 3 alapú párhuzamos vizsgálat, `ip neigh` / `arp -an` / `/proc/net/arp` MAC-forrás; `ifconfig` tartalék az interfészlistához.
- Élő találatlista vizsgálat közben, Leállítás gomb, CSV export, „Észlelés” oszlop (ping / tcp / arp), az agent saját címének jelölése.
- Rövidített tartomány megadása is működik (pl. `10.0.0.1-254`), /20-nál nagyobb hálózatú interfésznél a saját /24 kerül felajánlásra.

## 1.2.2
- Agentenkénti parancssor (hibás: a felszabadító függvény nem volt exportálva).

## 1.2.1
- A MeshCentral WebSocket válaszkezelés egységesítése.

## 1.2.0
- MAC-cím OUI alapján gyártófelismerés, folyamatjelző 128 címes részletekkel.

## 1.1.0
- Linux agent támogatás (runcommands type 3, Python 3).

## 1.0.0
- Első Windows verzió.
