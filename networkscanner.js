/**
 * MeshCentral Network Scanner - 2.0.0
 *
 * IPv4 eszközfelderítés a kiválasztott agent gépéről (Windows: PowerShell,
 * Linux/macOS: sh + Python 3). A vizsgálat az agenten fut, nem a szerveren.
 *
 * Fontos tudnivalók a MeshCentral működéséről, amikre a plugin épít:
 *
 *  - A MeshCentral a "B" objektumban felsorolt függvényeket szöveggé alakítja és
 *    a böngészőben futtatja (pluginHandler.networkscanner.*). Ezek NEM
 *    hivatkozhatnak a fájl változóira (B, obj, parent...), csak a böngésző
 *    globáljaira és a pluginHandler.networkscanner-re. Az exportlista ebből a
 *    objektumból automatikusan készül, így nem maradhat ki függvény.
 *
 *  - Az agent egyszerre csak EGY "runcommands" kérést futtat; ha közben újabb
 *    jön, azt eldobja ("Run commands can't execute, already busy.") és nem
 *    válaszol rá. Ezért a plugin a böngészőben egy közös, agentenkénti sort
 *    tart fenn: a saját kéréseit ÉS a többi plugin (pl. cfgcheck) reply:true
 *    kéréseit is ezen a soron vezeti át (a meshserver.send becsomagolásával),
 *    így egymást nem tudják kiütni. A más pluginek kérései elsőbbséget kapnak.
 *
 *  - Az agent a PowerShell scriptet stdin-ről olvassa (-command -), ahol a
 *    többsoros utasítások nem megbízhatóak. Ezért a Windows scriptek base64-ben
 *    mennek át, rövid, önálló sorokban, és Invoke-Expression futtatja őket.
 *
 *  - A MeshCentral minden eszközfrissítéskor törli a plugin füleket és újra
 *    meghívja az onDeviceRefreshEnd-et. A plugin ezért semmilyen parancsot nem
 *    küld ebből a hookból; az állapotot (interfészek, futó vizsgálat,
 *    eredmény) eszközönként a memóriában tartja és abból rajzolja újra a fület.
 */
module.exports.networkscanner = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.server_startup = function () { };

    // -----------------------------------------------------------------------
    // Böngészőben futó függvények
    // -----------------------------------------------------------------------
    var B = {

        // ---------------- Hookok ----------------

        onWebUIStartupEnd: function () {
            // A többi plugin hookjai után telepítünk, így a mi üzenetkezelőnk lesz
            // a legkülső: minden választ elsőként látunk, és a sort fel tudjuk
            // szabadítani akkor is, ha egy másik plugin elnyeli a saját válaszát.
            setTimeout(function () { try { pluginHandler.networkscanner.install(0); } catch (ex) { console.log('Network Scanner install:', ex); } }, 0);
        },

        onDeviceRefreshEnd: function (nodeid, panel, refresh, event) {
            try {
                var h = pluginHandler.networkscanner;
                h.install(0);
                pluginHandler.registerPluginTab({ tabId: 'pluginNetworkScanner', tabTitle: 'Network Scanner' });
                var node = (typeof currentNode !== 'undefined') ? currentNode : null;
                if (!node || (nodeid && node._id !== nodeid)) return;
                h.buildTab(node);
            } catch (ex) { console.log('Network Scanner onDeviceRefreshEnd:', ex); }
        },

        // ---------------- Telepítés: közös parancssor ----------------

        install: function (attempt) {
            var h = pluginHandler.networkscanner;
            if (typeof meshserver === 'undefined' || meshserver == null) {
                if (attempt < 20) setTimeout(function () { h.install(attempt + 1); }, 500);
                return;
            }
            if (meshserver._networkScannerInstalled) return;
            meshserver._networkScannerInstalled = true;
            h.queues = h.queues || {};
            h.jobs = h.jobs || {};
            h.state = h.state || {};
            h.seq = h.seq || 0;

            var origSend = meshserver.send;
            h.rawSend = function (m) { return origSend.call(meshserver, m); };
            meshserver.send = function (m) {
                try {
                    if (h.isQueueable(m)) {
                        h.enqueue(m.nodeids[0], { rid: m.responseid, msg: m, foreign: true, timeoutMs: 90000 });
                        return;
                    }
                } catch (ex) { console.log('Network Scanner send:', ex); }
                return origSend.apply(this, arguments);
            };

            var origOnMessage = meshserver.onMessage;
            meshserver.onMessage = function (server, message) {
                var m = (message && typeof message === 'object') ? message : server;
                var consumed = false;
                try { consumed = h.onIncoming(m); } catch (ex) { console.log('Network Scanner onMessage:', ex); }
                if (consumed) return;
                if (origOnMessage) return origOnMessage.apply(this, arguments);
            };

            // A fül megnyitásakor (kattintás vagy a MeshCentral által visszaállított
            // utolsó fül) egyszer, automatikusan lekérjük az interfészeket.
            if (typeof pluginHandler.callPluginPage === 'function' && !pluginHandler._nsPageHooked) {
                pluginHandler._nsPageHooked = true;
                var origPage = pluginHandler.callPluginPage;
                pluginHandler.callPluginPage = function (id, el) {
                    var r = origPage.apply(this, arguments);
                    if (id === 'pluginNetworkScanner') { try { h.onTabShown(); } catch (ex) { console.log('Network Scanner tab:', ex); } }
                    return r;
                };
            }
        },

        // Más pluginek (pl. cfgcheck) válaszkérő runcommands kérései is a sorra kerülnek.
        isQueueable: function (m) {
            return !!(m && m.action === 'runcommands' && m.reply === true &&
                typeof m.responseid === 'string' && Array.isArray(m.nodeids) && m.nodeids.length === 1 &&
                typeof m.nodeids[0] === 'string');
        },

        queueOf: function (nodeid) {
            var h = pluginHandler.networkscanner;
            return h.queues[nodeid] || (h.queues[nodeid] = { active: null, jobs: [] });
        },

        enqueue: function (nodeid, job) {
            var h = pluginHandler.networkscanner, q = h.queueOf(nodeid);
            job.nodeid = nodeid; job.done = false; job.retries = 0;
            h.jobs[job.rid] = job;
            if (job.foreign) {
                // Más plugin kérése: a várakozó saját kéréseink elé kerül.
                var pos = 0;
                while (pos < q.jobs.length && q.jobs[pos].foreign) pos++;
                q.jobs.splice(pos, 0, job);
            } else {
                q.jobs.push(job);
            }
            h.pump(nodeid);
        },

        pump: function (nodeid) {
            var h = pluginHandler.networkscanner, q = h.queueOf(nodeid);
            if (q.active || q.jobs.length === 0) return;
            var job = q.jobs.shift();
            q.active = job;
            h.sendJob(job);
        },

        sendJob: function (job) {
            var h = pluginHandler.networkscanner;
            job.sentAt = Date.now();
            job.started = false;
            clearTimeout(job.timer);
            job.timer = setTimeout(function () { h.finishJob(job, null, true); }, job.timeoutMs);
            h.rawSend(job.msg);
        },

        finishJob: function (job, message, timedOut) {
            var h = pluginHandler.networkscanner;
            if (job.done) return;
            job.done = true;
            clearTimeout(job.timer); clearTimeout(job.retryTimer);
            delete h.jobs[job.rid];
            var q = h.queueOf(job.nodeid);
            if (q.active === job) q.active = null;
            else { var i = q.jobs.indexOf(job); if (i >= 0) q.jobs.splice(i, 1); }
            if (!job.foreign) {
                try {
                    if (timedOut) { if (job.onTimeout) job.onTimeout(); }
                    else if (job.onDone) job.onDone((message && typeof message.result === 'string') ? message.result : '', message);
                } catch (ex) { console.log('Network Scanner job:', ex); }
            }
            // Kis szünet, hogy az agent biztosan felszabaduljon.
            setTimeout(function () { h.pump(job.nodeid); }, 100);
        },

        // true = az üzenetet mi dolgoztuk fel, ne menjen tovább.
        onIncoming: function (m) {
            var h = pluginHandler.networkscanner;
            if (!m || typeof m !== 'object') return false;
            var isReply = (m.action === 'runcommands' || (m.action === 'msg' && m.type === 'runcommands')) && typeof m.responseid === 'string';
            if (isReply) {
                var job = h.jobs[m.responseid];
                if (job) { h.finishJob(job, m, false); return !job.foreign; }
                return m.responseid.indexOf('networkscanner:') === 0; // késve érkezett saját válasz
            }
            if (m.action === 'msg' && m.type === 'console' && typeof m.nodeid === 'string' && typeof m.value === 'string') {
                h.onConsole(m.nodeid, m.value);
            }
            return false;
        },

        // Az agent a parancsok kimenetét és a "busy" hibát is konzolüzenetként küldi.
        onConsole: function (nodeid, text) {
            var h = pluginHandler.networkscanner, q = h.queues[nodeid];
            if (!q || !q.active) return;
            var job = q.active;
            if (text.indexOf('already busy') >= 0) {
                // Valószínűleg a mi kérésünket dobta el (pl. egy másik böngészőből indított parancs fut).
                if (!job.started && !job.retryTimer && (Date.now() - job.sentAt) < 4000 && job.retries < 6) {
                    job.retries++;
                    if (!job.foreign) h.setStatus(job.nodeid, 'Az agent foglalt (másik parancs fut), újrapróbálás...');
                    job.retryTimer = setTimeout(function () {
                        job.retryTimer = null;
                        if (!job.done && !job.started) h.sendJob(job);
                    }, 1500 + job.retries * 1000);
                }
                return;
            }
            if (!job.marker || text.indexOf(job.marker) >= 0) job.started = true;
        },

        // ---------------- Segédfüggvények ----------------

        esc: function (s) {
            return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        },

        isWindowsNode: function (node) {
            var aid = (node && node.agent != null) ? node.agent.id : 0;
            return ((aid > 0) && (aid < 5)) || ((aid > 41) && (aid < 44));
        },

        stateOf: function (nodeid) {
            var h = pluginHandler.networkscanner;
            h.state = h.state || {};
            return h.state[nodeid] || (h.state[nodeid] = {
                ifaces: null, ifLoading: false, ifRequested: false, ifError: '', ifVer: 0,
                selected: '', custom: '', ports: true, status: '', scan: null, result: null
            });
        },

        newRid: function (nodeid, kind) {
            var h = pluginHandler.networkscanner;
            h.seq = (h.seq || 0) + 1;
            return { rid: 'networkscanner:' + kind + ':' + nodeid + ':' + Date.now() + ':' + h.seq, marker: 'NSRUN|' + Date.now() + '-' + h.seq };
        },

        ipToNum: function (ip) {
            var a = String(ip).trim().split('.');
            if (a.length !== 4) throw new Error('Hibás IPv4 cím: ' + ip);
            var n = 0;
            for (var i = 0; i < 4; i++) {
                if (!/^\d{1,3}$/.test(a[i]) || Number(a[i]) > 255) throw new Error('Hibás IPv4 cím: ' + ip);
                n = n * 256 + Number(a[i]);
            }
            return n;
        },

        numToIp: function (n) {
            return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');
        },

        // "10.0.0.0/24", "10.0.0.1-10.0.0.50", "10.0.0.1-50", "10.0.0.7" -> { first, last }
        parseRange: function (text) {
            var h = pluginHandler.networkscanner, t = String(text || '').replace(/\s+/g, ''), first, last, m;
            if ((m = t.match(/^([\d.]+)\/(\d{1,2})$/))) {
                var prefix = Number(m[2]);
                if (prefix < 20 || prefix > 32) throw new Error('A CIDR prefix /20 és /32 között legyen (legfeljebb 4094 cím).');
                var size = Math.pow(2, 32 - prefix), net = Math.floor(h.ipToNum(m[1]) / size) * size;
                first = (prefix < 31) ? net + 1 : net;
                last = (prefix < 31) ? net + size - 2 : net + size - 1;
            } else if ((m = t.match(/^([\d.]+)-([\d.]+)$/))) {
                first = h.ipToNum(m[1]);
                if (/^\d{1,3}$/.test(m[2])) {
                    if (Number(m[2]) > 255) throw new Error('Hibás tartomány vége: ' + m[2]);
                    last = Math.floor(first / 256) * 256 + Number(m[2]);
                } else last = h.ipToNum(m[2]);
                if (last < first) throw new Error('A tartomány vége kisebb a kezdeténél.');
            } else if (/^[\d.]+$/.test(t)) {
                first = last = h.ipToNum(t);
            } else {
                throw new Error('Adj meg CIDR-t (10.0.0.0/24), tartományt (10.0.0.1-10.0.0.254) vagy egy IP-címet.');
            }
            if (last - first + 1 > 4094) throw new Error('Túl nagy tartomány (legfeljebb 4094 cím).');
            return { first: first, last: last };
        },

        // Egy interfész IP-jéből és prefixéből ajánlott tartomány (túl nagy hálózatnál a saját /24).
        suggestRange: function (ip, prefix) {
            var h = pluginHandler.networkscanner, p = Number(prefix), n = h.ipToNum(ip);
            if (!(p >= 0 && p <= 32)) p = 24;
            if (p < 20) p = 24;
            var size = Math.pow(2, 32 - p);
            return h.numToIp(Math.floor(n / size) * size) + '/' + p;
        },

        parseLines: function (text) {
            return String(text || '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).map(function (l) { return l.replace(/^[\s\uFEFF]+|\s+$/g, ''); });
        },

        // PowerShell szkript csomagolása: base64 darabok, minden sor önálló utasítás.
        psWrap: function (script) {
            var b64 = btoa(unescape(encodeURIComponent(script)));
            var L = ["$ErrorActionPreference='SilentlyContinue'",
                "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}",
                "$nsB=''"];
            for (var i = 0; i < b64.length; i += 1000) L.push("$nsB+='" + b64.substring(i, i + 1000) + "'");
            L.push("Invoke-Expression ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($nsB)))");
            return L.join('\r\n');
        },

        portList: function () { return [21, 22, 23, 80, 443, 445, 502, 3389, 8080, 8443, 11740]; },

        // ---------------- Agent oldali scriptek ----------------

        winInterfaceScript: function (marker) {
            return [
                "$ErrorActionPreference='SilentlyContinue'",
                "Write-Output '" + marker + "'",
                "$gw=@{}",
                "try { Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | ForEach-Object { $k=[string]$_.ifIndex; if (-not $gw.ContainsKey($k)) { $gw[$k]=[string]$_.NextHop } } } catch {}",
                "$n=0",
                "try {",
                "  Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object {",
                "    $n++",
                "    Write-Output ('NETSCANIF|' + ([string]$_.InterfaceAlias -replace '\\|','/') + '|' + $_.IPAddress + '|' + $_.PrefixLength + '|' + $gw[[string]$_.InterfaceIndex])",
                "  }",
                "} catch {}",
                "if ($n -eq 0) {",
                "  Get-WmiObject Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' | ForEach-Object {",
                "    $c=$_; $addrs=@($c.IPAddress); $masks=@($c.IPSubnet)",
                "    for ($i=0; $i -lt $addrs.Count; $i++) {",
                "      $ip=[string]$addrs[$i]",
                "      if ($ip -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' -and $ip -notlike '127.*' -and $ip -notlike '169.254.*') {",
                "        $p=0; foreach ($o in ([string]$masks[$i]).Split('.')) { $p += ([Convert]::ToString([int]$o,2) -replace '0','').Length }",
                "        Write-Output ('NETSCANIF|' + ([string]$c.Description -replace '\\|','/') + '|' + $ip + '|' + $p + '|' + [string](@($c.DefaultIPGateway)[0]))",
                "      }",
                "    }",
                "  }",
                "}",
                "Write-Output 'NETSCANIF|END'"
            ].join('\r\n');
        },

        winScanScript: function (ips, ports, marker) {
            return [
                "$ErrorActionPreference='SilentlyContinue'",
                "Write-Output '" + marker + "'",
                "try {",
                "  $ips=@('" + ips.join("','") + "')",
                "  $ports=@(" + ports.join(',') + ")",
                "  $inRange=@{}; foreach ($ip in $ips) { $inRange[$ip]=1 }",
                // ICMP és TCP párhuzamosan, aszinkron
                "  $pings=@{}",
                "  foreach ($ip in $ips) { try { $pings[$ip]=(New-Object System.Net.NetworkInformation.Ping).SendPingAsync($ip, 1000) } catch {} }",
                "  $conns=New-Object System.Collections.ArrayList",
                "  foreach ($ip in $ips) { foreach ($port in $ports) { try { $c=New-Object System.Net.Sockets.TcpClient; [void]$conns.Add(@($ip, $port, $c, $c.ConnectAsync($ip, [int]$port))) } catch {} } }",
                "  $deadline=(Get-Date).AddMilliseconds(1600)",
                "  while ((Get-Date) -lt $deadline) {",
                "    $busy=$false",
                "    foreach ($t in $pings.Values) { if (-not $t.IsCompleted) { $busy=$true; break } }",
                "    if (-not $busy) { foreach ($x in $conns) { if (-not $x[3].IsCompleted) { $busy=$true; break } } }",
                "    if (-not $busy) { break }",
                "    Start-Sleep -Milliseconds 50",
                "  }",
                "  $via=@{}; $open=@{}",
                "  foreach ($ip in $ips) { $t=$pings[$ip]; if ($t -and $t.Status -eq 'RanToCompletion' -and $t.Result.Status -eq 'Success') { $via[$ip]='ping' } }",
                "  foreach ($x in $conns) {",
                "    if ($x[3].Status -eq 'RanToCompletion' -and $x[2].Connected) {",
                "      $ip=$x[0]",
                "      if (-not $open.ContainsKey($ip)) { $open[$ip]=@() }",
                "      $open[$ip] += $x[1]",
                "      if ($via.ContainsKey($ip)) { if ($via[$ip] -notmatch 'tcp') { $via[$ip] += ',tcp' } } else { $via[$ip]='tcp' }",
                "    }",
                "    try { $x[2].Close() } catch {}",
                "  }",
                // ARP / neighbor tábla: MAC-cím és a pingre nem válaszoló, de ARP-ra igen eszközök
                "  $mac=@{}; $nb=$null",
                "  try { $nb=@(Get-NetNeighbor -AddressFamily IPv4) } catch {}",
                "  if ($nb -and $nb.Count -gt 0) {",
                "    foreach ($e in $nb) {",
                "      $a=[string]$e.IPAddress; if (-not $inRange.ContainsKey($a)) { continue }",
                "      $l=[string]$e.LinkLayerAddress; $hx=($l -replace '[^0-9A-Fa-f]','')",
                "      if ($hx.Length -ne 12 -or $hx -match '^0+$' -or $hx -match '^[fF]+$') { continue }",
                "      if (-not $mac.ContainsKey($a)) { $mac[$a]=$l }",
                "      $s=[string]$e.State",
                "      if ($s -eq 'Reachable' -or $s -eq 'Delay' -or $s -eq 'Probe') { if ($via.ContainsKey($a)) { if ($via[$a] -notmatch 'arp') { $via[$a] += ',arp' } } else { $via[$a]='arp' } }",
                "    }",
                "  } else {",
                "    $arpLines=@(); try { $arpLines=@(arp -a) } catch {}",
                "    foreach ($line in $arpLines) {",
                "      if ([string]$line -match '^\\s*(\\d+\\.\\d+\\.\\d+\\.\\d+)\\s+([0-9a-fA-F]{2}(-[0-9a-fA-F]{2}){5})') {",
                "        $a=$Matches[1]; $l=$Matches[2]",
                "        if ($inRange.ContainsKey($a) -and $l -notmatch '^(ff-){5}ff$' -and -not $mac.ContainsKey($a)) { $mac[$a]=$l }",
                "      }",
                "    }",
                "  }",
                // Reverse DNS párhuzamosan, legfeljebb 2 mp
                "  $dns=@{}",
                "  foreach ($ip in @($via.Keys)) { try { $dns[$ip]=[System.Net.Dns]::GetHostEntryAsync($ip) } catch {} }",
                "  $deadline=(Get-Date).AddMilliseconds(2000)",
                "  while ((Get-Date) -lt $deadline) { $busy=$false; foreach ($t in $dns.Values) { if (-not $t.IsCompleted) { $busy=$true; break } }; if (-not $busy) { break }; Start-Sleep -Milliseconds 50 }",
                "  foreach ($ip in @($via.Keys)) {",
                "    $name=''; $t=$dns[$ip]",
                "    if ($t -and $t.Status -eq 'RanToCompletion') { $name=[string]$t.Result.HostName; if ($name -eq $ip) { $name='' } }",
                "    $p=''; if ($open.ContainsKey($ip)) { $p=(@($open[$ip]) -join ',') }",
                "    Write-Output ('NETSCAN|HOST|' + $ip + '|' + ($name -replace '\\|','') + '|' + [string]$mac[$ip] + '|' + $p + '|' + $via[$ip])",
                "  }",
                "  Write-Output ('NETSCAN|DONE|' + $via.Count + '|' + $ips.Count)",
                "} catch { Write-Output ('NETSCAN|ERROR|' + $_.Exception.Message) }"
            ].join('\r\n');
        },

        unixInterfaceScript: function (marker) {
            return [
                "echo '" + marker + "'",
                "if command -v ip >/dev/null 2>&1; then",
                "  ip -o -4 addr show 2>/dev/null | while read -r idx iface fam addr rest; do",
                "    case \"$addr\" in 127.*|169.254.*|'') continue;; esac",
                "    dev=\"${iface%@*}\"",
                "    gw=$(ip -4 route show default dev \"$dev\" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i==\"via\"){print $(i+1); exit}}')",
                "    echo \"NETSCANIF|$dev|${addr%/*}|${addr#*/}|$gw\"",
                "  done",
                "elif command -v ifconfig >/dev/null 2>&1; then",
                "  ifconfig -a 2>/dev/null | awk '",
                "    function hexv(c) { return index(\"0123456789abcdef\", tolower(c)) - 1 }",
                "    function pfx(m,   n, i, v, b, parts) {",
                "      n = 0",
                "      if (m ~ /^0x/) { for (i = 3; i <= length(m); i++) { v = hexv(substr(m, i, 1)); for (b = 8; b >= 1; b = b / 2) if (v >= b) { n++; v -= b } } }",
                "      else { split(m, parts, \".\"); for (i = 1; i <= 4; i++) { v = parts[i] + 0; for (b = 128; b >= 1; b = b / 2) if (v >= b) { n++; v -= b } } }",
                "      return n",
                "    }",
                "    /^[^ \\t]/ { ifc = $1; sub(/:$/, \"\", ifc) }",
                "    /inet / {",
                "      ip = \"\"; m = \"\"",
                "      for (i = 1; i <= NF; i++) { if ($i == \"inet\") ip = $(i + 1); if ($i == \"netmask\") m = $(i + 1); if ($i ~ /^Mask:/) m = substr($i, 6) }",
                "      sub(/^addr:/, \"\", ip); sub(/\\/.*/, \"\", ip)",
                "      if (ip == \"\" || ip ~ /^127\\./ || ip ~ /^169\\.254\\./ || m == \"\") next",
                "      print \"NETSCANIF|\" ifc \"|\" ip \"|\" pfx(m) \"|\"",
                "    }'",
                "else",
                "  echo 'NETSCANIF|ERR|NOIP'",
                "fi",
                "echo 'NETSCANIF|END'"
            ].join('\n');
        },

        unixScanScript: function (first, last, ports, marker) {
            return [
                "echo '" + marker + "'",
                "command -v python3 >/dev/null 2>&1 || { echo 'NETSCAN|ERROR|NOPYTHON'; exit 0; }",
                "python3 - " + first + " " + last + " '" + ports.join(',') + "' <<'NSPYEOF'",
                "import sys, os, re, socket, subprocess, threading, time",
                "try:",
                "    from concurrent.futures import ThreadPoolExecutor",
                "    first, last = int(sys.argv[1]), int(sys.argv[2])",
                "    ports = [int(x) for x in sys.argv[3].split(',') if x]",
                "    ips = [socket.inet_ntoa(n.to_bytes(4, 'big')) for n in range(first, last + 1)]",
                "    inrange = set(ips)",
                "    DN = subprocess.DEVNULL",
                "    def ping_cmd(a):",
                "        if sys.platform.startswith('linux'): return ['ping', '-c', '1', '-W', '1', a]",
                "        return ['ping', '-c', '1', '-t', '1', a]",
                "    def probe(a):",
                "        ok = False; opened = []",
                "        try: ok = subprocess.call(ping_cmd(a), stdin=DN, stdout=DN, stderr=DN, timeout=3) == 0",
                "        except Exception: pass",
                "        for p in ports:",
                "            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.settimeout(0.4)",
                "            try:",
                "                if s.connect_ex((a, p)) == 0: opened.append(p)",
                "            except Exception: pass",
                "            finally: s.close()",
                "        return (a, ok, opened)",
                "    alive = {}",
                "    with ThreadPoolExecutor(max_workers=min(128, len(ips))) as pool:",
                "        for a, ok, opened in pool.map(probe, ips):",
                "            via = []",
                "            if ok: via.append('ping')",
                "            if opened: via.append('tcp')",
                "            if via: alive[a] = [via, opened]",
                "    macs = {}",
                "    def addmac(a, m):",
                "        m = ':'.join(x.zfill(2) for x in m.lower().split(':'))",
                "        if a in inrange and m not in ('00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff'): macs.setdefault(a, m)",
                "    try:",
                "        out = subprocess.check_output(['ip', 'neigh', 'show'], stderr=DN, timeout=3).decode('utf-8', 'replace')",
                "        for line in out.splitlines():",
                "            f = line.split()",
                "            if not f or f[0] not in inrange or 'lladdr' not in f: continue",
                "            addmac(f[0], f[f.index('lladdr') + 1])",
                "            if f[-1] in ('REACHABLE', 'DELAY', 'PROBE'):",
                "                v = alive.setdefault(f[0], [[], []])[0]",
                "                if 'arp' not in v: v.append('arp')",
                "    except Exception:",
                "        try:",
                "            out = subprocess.check_output(['arp', '-an'], stderr=DN, timeout=3).decode('utf-8', 'replace')",
                "            for line in out.splitlines():",
                "                mm = re.search(r'\\((\\d+\\.\\d+\\.\\d+\\.\\d+)\\) at ([0-9a-fA-F:]+)', line)",
                "                if mm and mm.group(2).count(':') == 5: addmac(mm.group(1), mm.group(2))",
                "        except Exception: pass",
                "    if not macs and os.path.exists('/proc/net/arp'):",
                "        try:",
                "            for line in open('/proc/net/arp').read().splitlines()[1:]:",
                "                f = line.split()",
                "                if len(f) >= 4 and f[2] != '0x0': addmac(f[0], f[3])",
                "        except Exception: pass",
                "    names = {}",
                "    def rdns(a):",
                "        try: names[a] = socket.gethostbyaddr(a)[0]",
                "        except Exception: pass",
                "    ths = []",
                "    for a in alive:",
                "        t = threading.Thread(target=rdns, args=(a,)); t.daemon = True; t.start(); ths.append(t)",
                "    deadline = time.time() + 2.5",
                "    for t in ths: t.join(max(0, deadline - time.time()))",
                "    for a in sorted(alive, key=lambda x: socket.inet_aton(x)):",
                "        via, opened = alive[a]",
                "        print('NETSCAN|HOST|%s|%s|%s|%s|%s' % (a, names.get(a, '').replace('|', ''), macs.get(a, ''), ','.join(map(str, opened)), ','.join(via)))",
                "    print('NETSCAN|DONE|%d|%d' % (len(alive), len(ips)))",
                "except Exception as e:",
                "    print('NETSCAN|ERROR|' + str(e).replace('\\n', ' '))",
                "sys.stdout.flush()",
                "os._exit(0)",
                "NSPYEOF"
            ].join('\n');
        },

        // ---------------- Interfészek ----------------

        onTabShown: function () {
            var h = pluginHandler.networkscanner;
            if (typeof currentNode === 'undefined' || !currentNode) return;
            var st = h.stateOf(currentNode._id);
            if (!st.ifRequested && (currentNode.conn & 1)) h.loadInterfaces();
        },

        loadInterfaces: function () {
            var h = pluginHandler.networkscanner;
            if (typeof currentNode === 'undefined' || !currentNode) return;
            var node = currentNode, st = h.stateOf(node._id);
            if (!node.agent) { h.setStatus(node._id, 'Ennek az eszköznek nincs Mesh Agentje.'); return; }
            if ((node.conn & 1) === 0) { h.setStatus(node._id, 'Az agent nincs kapcsolódva.'); return; }
            if (st.ifLoading) return;
            var isWin = h.isWindowsNode(node), r = h.newRid(node._id, 'if');
            st.ifRequested = true; st.ifLoading = true; st.ifError = '';
            h.setStatus(node._id, 'Hálózati interfészek lekérdezése...');
            h.enqueue(node._id, {
                rid: r.rid, marker: r.marker, timeoutMs: 45000,
                msg: { action: 'runcommands', nodeids: [node._id], type: isWin ? 2 : 3,
                    cmds: isWin ? h.psWrap(h.winInterfaceScript(r.marker)) : h.unixInterfaceScript(r.marker),
                    runAsUser: 0, reply: true, responseid: r.rid },
                onDone: function (result) { h.onInterfaces(node._id, result); },
                onTimeout: function () {
                    st.ifLoading = false; st.ifError = 'Időtúllépés az interfészek lekérdezésekor.';
                    h.setStatus(node._id, st.ifError); h.refreshIfaces(node._id);
                }
            });
            h.refreshIfaces(node._id);
        },

        onInterfaces: function (nodeid, result) {
            var h = pluginHandler.networkscanner, st = h.stateOf(nodeid), list = [], err = '', ended = false;
            h.parseLines(result).forEach(function (line) {
                if (line.indexOf('NETSCANIF|') !== 0) return;
                var a = line.split('|');
                if (a[1] === 'END') { ended = true; return; }
                if (a[1] === 'ERR') { err = (a[2] === 'NOIP') ? 'Sem az "ip", sem az "ifconfig" parancs nem található az agenten.' : a[2]; return; }
                try {
                    h.ipToNum(a[2]);
                    var range = h.suggestRange(a[2], a[3]);
                    var big = Number(a[3]) < 20;
                    list.push({ name: a[1], ip: a[2], prefix: a[3], gw: a[4] || '', range: range,
                        label: a[1] + ' — ' + a[2] + '/' + a[3] + (a[4] ? ' (GW: ' + a[4] + ')' : '') + ' → ' + range + (big ? ' (a nagy hálózatból a saját /24)' : '') });
                } catch (ex) { }
            });
            st.ifLoading = false;
            if (!ended && !list.length && !err) err = 'Nem érkezett értékelhető válasz: ' + String(result || '').substring(0, 300);
            st.ifaces = list; st.ifError = err; st.ifVer++;
            if (list.length && !list.some(function (x) { return x.range === st.selected; })) st.selected = list[0].range;
            h.setStatus(nodeid, err ? err : (list.length ? ('Interfészek: ' + list.length) : 'Nem található IPv4 interfész.'));
            h.refreshIfaces(nodeid);
        },

        // ---------------- Vizsgálat ----------------

        startScan: function () {
            var h = pluginHandler.networkscanner;
            if (typeof currentNode === 'undefined' || !currentNode) return;
            var node = currentNode, st = h.stateOf(node._id);
            h.readUi(node._id);
            if (st.scan && !st.scan.finished) return;
            if (!node.agent) { h.setStatus(node._id, 'Ennek az eszköznek nincs Mesh Agentje.'); return; }
            if ((node.conn & 1) === 0) { h.setStatus(node._id, 'Az agent nincs kapcsolódva.'); return; }
            var text = st.custom || st.selected, range;
            if (!text) { h.setStatus(node._id, 'Válassz interfészt, vagy adj meg saját tartományt.'); return; }
            try { range = h.parseRange(text); } catch (ex) { h.setStatus(node._id, ex.message); return; }
            var isWin = h.isWindowsNode(node), size = isWin ? 64 : 128, chunks = [];
            for (var n = range.first; n <= range.last; n += size) chunks.push([n, Math.min(range.last, n + size - 1)]);
            st.scan = { range: text, nodeName: node.name, isWin: isWin, ports: st.ports ? h.portList() : [],
                chunks: chunks, index: 0, done: 0, total: range.last - range.first + 1,
                hosts: {}, errors: [], timeouts: 0, cancelled: false, finished: false, started: new Date() };
            st.result = null;
            h.refreshAll(node._id);
            h.nextChunk(node._id);
        },

        stopScan: function () {
            var h = pluginHandler.networkscanner;
            if (typeof currentNode === 'undefined' || !currentNode) return;
            var st = h.stateOf(currentNode._id);
            if (st.scan && !st.scan.finished) {
                st.scan.cancelled = true;
                h.setStatus(currentNode._id, 'Leállítás: a futó rész-vizsgálat még befejeződik...');
            }
        },

        nextChunk: function (nodeid) {
            var h = pluginHandler.networkscanner, st = h.stateOf(nodeid), scan = st.scan;
            if (!scan || scan.finished) return;
            if (scan.cancelled || scan.index >= scan.chunks.length) { h.finishScan(nodeid); return; }
            var c = scan.chunks[scan.index], count = c[1] - c[0] + 1, r = h.newRid(nodeid, 'scan'), cmds;
            if (scan.isWin) {
                var ips = [];
                for (var n = c[0]; n <= c[1]; n++) ips.push(h.numToIp(n));
                cmds = h.psWrap(h.winScanScript(ips, scan.ports, r.marker));
            } else {
                cmds = h.unixScanScript(c[0], c[1], scan.ports, r.marker);
            }
            var label = h.numToIp(c[0]) + ' – ' + h.numToIp(c[1]);
            h.setStatus(nodeid, 'Vizsgálat: ' + label + ' (' + (scan.index + 1) + '/' + scan.chunks.length + ')');
            var advance = function () { scan.index++; scan.done += count; h.refreshProgress(nodeid); h.nextChunk(nodeid); };
            h.enqueue(nodeid, {
                rid: r.rid, marker: r.marker, timeoutMs: 90000,
                msg: { action: 'runcommands', nodeids: [nodeid], type: scan.isWin ? 2 : 3, cmds: cmds, runAsUser: 0, reply: true, responseid: r.rid },
                onDone: function (result) {
                    var done = false, error = '';
                    h.parseLines(result).forEach(function (line) {
                        if (line.indexOf('NETSCAN|HOST|') === 0) {
                            var a = line.split('|');
                            if (a[2]) scan.hosts[a[2]] = { ip: a[2], name: a[3] || '', mac: a[4] || '', ports: a[5] || '', via: a[6] || '' };
                        } else if (line.indexOf('NETSCAN|DONE|') === 0) done = true;
                        else if (line.indexOf('NETSCAN|ERROR|') === 0) error = line.substring(14);
                    });
                    scan.timeouts = 0;
                    if (error === 'NOPYTHON') error = 'Az agent gépen nincs python3 (Linux/macOS alatt ez szükséges a vizsgálathoz).';
                    if (!done && !error) {
                        var raw = String(result || '').trim();
                        error = 'Váratlan válasz az agenttől' + (raw ? (': ' + raw.substring(0, 400)) : ' (üres kimenet).');
                    }
                    if (error) { scan.errors.push(error); scan.cancelled = true; h.finishScan(nodeid); return; }
                    advance();
                },
                onTimeout: function () {
                    scan.errors.push('Időtúllépés: ' + label);
                    scan.timeouts++;
                    if (scan.timeouts >= 2) { scan.cancelled = true; h.finishScan(nodeid); return; }
                    advance();
                }
            });
            h.refreshProgress(nodeid);
        },

        finishScan: function (nodeid) {
            var h = pluginHandler.networkscanner, st = h.stateOf(nodeid), scan = st.scan;
            if (!scan || scan.finished) return;
            scan.finished = true;
            var hosts = h.sortedHosts(scan.hosts);
            st.result = { hosts: hosts, range: scan.range, nodeName: scan.nodeName, when: new Date(),
                done: scan.done, total: scan.total, errors: scan.errors.slice(0), cancelled: scan.cancelled };
            var msg = (scan.cancelled ? (scan.errors.length ? 'Megszakadt. ' : 'Leállítva. ') : 'Kész. ') + 'Talált eszközök: ' + hosts.length;
            h.setStatus(nodeid, msg);
            h.refreshAll(nodeid);
        },

        sortedHosts: function (map) {
            var h = pluginHandler.networkscanner;
            return Object.keys(map).map(function (k) { return map[k]; })
                .sort(function (a, b) { return h.ipToNum(a.ip) - h.ipToNum(b.ip); });
        },

        // ---------------- OUI ----------------

        ouiTable: function () {
            return {
                '000C29': 'VMware', '005056': 'VMware', '000569': 'VMware', '080027': 'VirtualBox', '001C42': 'Parallels',
                '00155D': 'Microsoft Hyper-V', '525400': 'QEMU/KVM', '00163E': 'Xen',
                'B827EB': 'Raspberry Pi', 'DCA632': 'Raspberry Pi', 'E45F01': 'Raspberry Pi', '2CCF67': 'Raspberry Pi', 'D83ADD': 'Raspberry Pi',
                '001B21': 'Intel', '3CFDFE': 'Intel', 'A44CC8': 'Intel',
                '001B63': 'Apple', '3C22FB': 'Apple', 'F01898': 'Apple',
                '000C85': 'Cisco', '001B0C': 'Cisco', '001E49': 'Cisco',
                '001E65': 'Samsung', '002454': 'Samsung', '8C7712': 'Samsung',
                'F4F5D8': 'Google', '001D7E': 'HPE', '3CD92B': 'HPE', '001F29': 'HPE',
                '001E0B': 'Dell', '002219': 'Dell', 'F8BC12': 'Dell', '001B78': 'HP', '3C5282': 'HP',
                '7C1E52': 'Microsoft', '0003FF': 'Microsoft', '001DD8': 'Microsoft',
                '002568': 'Huawei', '4846FB': 'Huawei',
                '50C7BF': 'TP-Link', 'B0BE76': 'TP-Link', '1C7EE5': 'D-Link', 'C8BE19': 'D-Link',
                '0018F8': 'Zyxel', 'A42BB0': 'Zyxel', '2C3033': 'Netgear', 'A00460': 'Netgear',
                '0090E8': 'Moxa', '0080F4': 'Schneider Electric', '0030DE': 'WAGO',
                '000E8C': 'Siemens', '001B1B': 'Siemens', '00A045': 'Phoenix Contact',
                '00D0C9': 'Advantech', '0418D6': 'Ubiquiti', '24A43C': 'Ubiquiti', '802AA8': 'Ubiquiti', 'F09FC2': 'Ubiquiti',
                '18FE34': 'Espressif', '5CCF7F': 'Espressif', '240AC4': 'Espressif', '30AEA4': 'Espressif'
            };
        },

        getVendor: function (mac) {
            var h = pluginHandler.networkscanner;
            if (!mac) return '';
            var clean = String(mac).toUpperCase().replace(/[^0-9A-F]/g, '');
            if (clean.length < 6) return '';
            if (!h._oui) h._oui = h.ouiTable();
            var v = h._oui[clean.substring(0, 6)];
            if (v) return v;
            if (parseInt(clean.substring(0, 2), 16) & 2) return 'Helyi/véletlen MAC';
            return 'Ismeretlen';
        },

        // ---------------- Felület ----------------

        buildTab: function (node) {
            var h = pluginHandler.networkscanner, st = h.stateOf(node._id), e = h.esc;
            var html;
            if (!node.agent) {
                html = '<div style="padding:8px">Ennek az eszköznek nincs Mesh Agentje, a hálózatvizsgálat nem futtatható.</div>';
            } else {
                html = '<div id="nsRoot" data-node="' + e(node._id) + '" style="padding:8px">' +
                    '<div style="margin-bottom:10px">A vizsgálat az agent gépéről indul (' + (h.isWindowsNode(node) ? 'Windows / PowerShell' : 'Linux, macOS / Python 3') + ').</div>' +
                    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
                    '<label for="nsIface">Hálózati interfész:</label>' +
                    '<select id="nsIface" data-ver="-1" style="min-width:320px;max-width:100%" onchange="pluginHandler.networkscanner.readUi()"></select>' +
                    '<input type="button" id="nsIfBtn" value="Interfészek lekérdezése" onclick="pluginHandler.networkscanner.loadInterfaces()" />' +
                    '</div>' +
                    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
                    '<label for="nsCustom">Saját IPv4 tartomány:</label>' +
                    '<input id="nsCustom" type="text" value="' + e(st.custom) + '" oninput="pluginHandler.networkscanner.readUi()" placeholder="pl. 10.151.10.0/24, 10.151.10.1-254 (üresen az interfészé)" style="width:360px;max-width:100%" />' +
                    '</div>' +
                    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
                    '<label><input type="checkbox" id="nsPorts"' + (st.ports ? ' checked' : '') + ' onchange="pluginHandler.networkscanner.readUi()" /> Gyakori TCP portok ellenőrzése</label>' +
                    '<input type="button" id="nsScanBtn" value="Vizsgálat indítása" onclick="pluginHandler.networkscanner.startScan()" />' +
                    '<input type="button" id="nsStopBtn" value="Leállítás" style="display:none" onclick="pluginHandler.networkscanner.stopScan()" />' +
                    '<span id="nsStatus"></span>' +
                    '</div>' +
                    '<div id="nsProgressWrap" style="display:none;margin:8px 0 12px 0">' +
                    '<div style="height:12px;background:#8884;border-radius:6px;overflow:hidden"><div id="nsProgressBar" style="height:100%;width:0%;background:#1683d8;transition:width .2s"></div></div>' +
                    '<div id="nsProgressText" style="font-size:90%;margin-top:4px"></div>' +
                    '</div>' +
                    '<div style="opacity:.75;font-size:90%;margin-bottom:10px">Legfeljebb 4094 cím (CIDR esetén /20 vagy kisebb). Csak olyan hálózatot vizsgálj, amelyre jogosult vagy.</div>' +
                    '<div id="nsResults"></div>' +
                    '</div>';
            }
            QH('pluginNetworkScanner', html);
            if (node.agent) h.refreshAll(node._id);
        },

        // A felület aktuális értékeinek mentése az állapotba.
        readUi: function (nodeid) {
            var h = pluginHandler.networkscanner, root = Q('nsRoot');
            if (!root) return;
            var id = nodeid || root.getAttribute('data-node');
            if (nodeid && root.getAttribute('data-node') !== nodeid) return;
            var st = h.stateOf(id), sel = Q('nsIface'), cus = Q('nsCustom'), por = Q('nsPorts');
            if (sel && sel.value) st.selected = sel.value;
            if (cus) st.custom = cus.value.trim();
            if (por) st.ports = !!por.checked;
        },

        isShown: function (nodeid) {
            var root = Q('nsRoot');
            return !!(root && root.getAttribute('data-node') === nodeid);
        },

        setStatus: function (nodeid, text) {
            var h = pluginHandler.networkscanner;
            h.stateOf(nodeid).status = text;
            if (h.isShown(nodeid)) { var s = Q('nsStatus'); if (s) s.textContent = text; }
        },

        refreshAll: function (nodeid) {
            var h = pluginHandler.networkscanner;
            if (!h.isShown(nodeid)) return;
            var s = Q('nsStatus'); if (s) s.textContent = h.stateOf(nodeid).status || '';
            h.refreshIfaces(nodeid);
            h.refreshProgress(nodeid);
            h.refreshResults(nodeid);
        },

        refreshIfaces: function (nodeid) {
            var h = pluginHandler.networkscanner;
            if (!h.isShown(nodeid)) return;
            var st = h.stateOf(nodeid), sel = Q('nsIface'), btn = Q('nsIfBtn');
            if (btn) btn.disabled = !!st.ifLoading;
            if (!sel) return;
            var ver = (st.ifLoading ? 'L' : '') + st.ifVer + (st.ifError ? 'E' : '');
            if (sel.getAttribute('data-ver') === ver) return;
            sel.setAttribute('data-ver', ver);
            sel.innerHTML = '';
            var add = function (value, text, selected) {
                var o = document.createElement('option'); o.value = value; o.textContent = text;
                if (selected) o.selected = true; sel.appendChild(o);
            };
            if (st.ifLoading) add('', 'Interfészek lekérdezése...', true);
            else if (st.ifaces && st.ifaces.length) st.ifaces.forEach(function (x) { add(x.range, x.label, x.range === st.selected); });
            else if (st.ifError) add('', 'Hiba: ' + st.ifError, true);
            else if (st.ifaces) add('', 'Nem található IPv4 interfész', true);
            else add('', 'Nyisd meg a fület, vagy kattints az "Interfészek lekérdezése" gombra', true);
        },

        refreshProgress: function (nodeid) {
            var h = pluginHandler.networkscanner;
            if (!h.isShown(nodeid)) return;
            var st = h.stateOf(nodeid), scan = st.scan, running = !!(scan && !scan.finished);
            var sb = Q('nsScanBtn'), xb = Q('nsStopBtn'), wrap = Q('nsProgressWrap'), bar = Q('nsProgressBar'), txt = Q('nsProgressText');
            if (sb) sb.disabled = running;
            if (xb) { xb.style.display = running ? '' : 'none'; xb.disabled = !!(scan && scan.cancelled); }
            if (!wrap) return;
            if (!scan) { wrap.style.display = 'none'; return; }
            wrap.style.display = 'block';
            var pct = scan.total ? Math.floor(scan.done / scan.total * 100) : 0;
            if (bar) bar.style.width = (scan.finished && !scan.cancelled ? 100 : pct) + '%';
            if (txt) txt.textContent = (scan.finished && !scan.cancelled ? 100 : pct) + '% — ' + scan.done + ' / ' + scan.total + ' cím — találat: ' + Object.keys(scan.hosts).length;
            if (running) h.refreshResults(nodeid);
        },

        refreshResults: function (nodeid) {
            var h = pluginHandler.networkscanner;
            if (!h.isShown(nodeid)) return;
            var st = h.stateOf(nodeid), box = Q('nsResults');
            if (!box) return;
            if (st.scan && !st.scan.finished) {
                var hosts = h.sortedHosts(st.scan.hosts);
                box.innerHTML = hosts.length ? h.renderTable(hosts, nodeid, false) : '';
            } else if (st.result) {
                box.innerHTML = h.renderResult(st.result, nodeid);
            } else box.innerHTML = '';
        },

        ownIps: function (nodeid) {
            var st = pluginHandler.networkscanner.stateOf(nodeid), r = {};
            (st.ifaces || []).forEach(function (x) { r[x.ip] = true; });
            return r;
        },

        renderResult: function (res, nodeid) {
            var h = pluginHandler.networkscanner, e = h.esc;
            var out = '<div style="margin:8px 0"><b>' + e(res.nodeName) + '</b> — ' + e(res.range) + ' — ' + e(res.when.toLocaleString()) +
                ' — vizsgált címek: ' + res.done + ' / ' + res.total + '</div>';
            res.errors.forEach(function (x) { out += '<div style="color:#c00;margin:4px 0;white-space:pre-wrap">' + e(x) + '</div>'; });
            if (!res.hosts.length) return out + '<p>Nem találtam pingre, ARP-ra vagy a vizsgált TCP portok valamelyikén válaszoló eszközt.</p>';
            return out + h.renderTable(res.hosts, nodeid, true);
        },

        renderTable: function (hosts, nodeid, withCsv) {
            var h = pluginHandler.networkscanner, e = h.esc, own = h.ownIps(nodeid);
            var td = 'padding:5px 8px;border:1px solid #8886';
            var out = '<div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%"><thead><tr>' +
                ['IP-cím', 'Gépnév (DNS)', 'MAC-cím', 'Gyártó (OUI)', 'Nyitott TCP portok', 'Észlelés'].map(function (x) {
                    return '<th style="text-align:left;' + td + '">' + x + '</th>';
                }).join('') + '</tr></thead><tbody>';
            hosts.forEach(function (x) {
                out += '<tr>' + [x.ip + (own[x.ip] ? ' (agent)' : ''), x.name || '—', x.mac || '—', h.getVendor(x.mac) || '—', x.ports || '—', x.via || '—']
                    .map(function (v) { return '<td style="' + td + '">' + e(v) + '</td>'; }).join('') + '</tr>';
            });
            out += '</tbody></table></div><div style="margin-top:6px">Talált eszközök: ' + hosts.length;
            if (withCsv) out += ' &nbsp; <input type="button" value="CSV letöltése" onclick="pluginHandler.networkscanner.downloadCsv()" />';
            return out + '</div><div style="opacity:.7;font-size:90%;margin-top:4px">Észlelés: ping = ICMP válasz, tcp = nyitott port, arp = csak ARP-ra válaszolt (pl. tűzfal tiltja a pinget).</div>';
        },

        downloadCsv: function () {
            var h = pluginHandler.networkscanner;
            if (typeof currentNode === 'undefined' || !currentNode) return;
            var res = h.stateOf(currentNode._id).result;
            if (!res) return;
            var q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
            var lines = ['IP;Gépnév;MAC;Gyártó;Portok;Észlelés'];
            res.hosts.forEach(function (x) { lines.push([x.ip, x.name, x.mac, h.getVendor(x.mac), x.ports, x.via].map(q).join(';')); });
            var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'networkscan_' + String(res.range).replace(/[^0-9A-Za-z.-]+/g, '_') + '.csv';
            document.body.appendChild(a); a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        }
    };

    for (var k in B) obj[k] = B[k];
    obj.exports = Object.keys(B);

    return obj;
};
