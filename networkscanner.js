/**
 * MeshCentral Network Scanner
 * Windows PowerShell (runcommands type 2) + Linux/BSD/macOS shell (type 3).
 * The scan runs on the selected agent, not on the MeshCentral server.
 */
module.exports.networkscanner = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;

    // Exported functions execute in the browser and must use pluginHandler.networkscanner.
    obj.exports = [
        'onWebUIStartupEnd', 'onDeviceRefreshEnd', 'esc',
        'windowsInterfaceScript', 'linuxInterfaceScript',
        'windowsScanScript', 'linuxScanScript',
        'ipToNumber', 'numberToIp', 'makeChunks', 'sendScanChunk', 'finishScan',
        'loadInterfaces', 'startScan', 'onResult', 'renderResults', 'getVendor'
    ];

    obj.server_startup = function () { };

    obj.onWebUIStartupEnd = function () {
        if (typeof meshserver === 'undefined' || meshserver == null || meshserver._networkScannerHooked) return;
        meshserver._networkScannerHooked = true;
        var orig = meshserver.onMessage;
        meshserver.onMessage = function (server, message) {
            if (message &&
                (message.action === 'runcommands' || (message.action === 'msg' && message.type === 'runcommands')) &&
                typeof message.responseid === 'string' &&
                message.responseid.indexOf('networkscanner:') === 0) {
                try { pluginHandler.networkscanner.onResult(message); }
                catch (ex) { console.log('Network Scanner hiba:', ex); }
                return;
            }
            if (orig) return orig.apply(this, arguments);
        };
    };

    obj.onDeviceRefreshEnd = function (nodeid, panel, refresh, event) {
        pluginHandler.registerPluginTab({ tabId: 'pluginNetworkScanner', tabTitle: 'Network Scanner' });
        var h = pluginHandler.networkscanner;
        var last = (h.last && currentNode && h.last[currentNode._id]) ? h.last[currentNode._id] : '';
        QH('pluginNetworkScanner',
            '<div style="padding:8px">' +
              '<div style="margin-bottom:10px">A vizsgálat a kiválasztott agent gépéről indul. Windows és Linux agent támogatott.</div>' +
              '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
                '<label for="nsInterface">Hálózati interfész:</label>' +
                '<select id="nsInterface" style="min-width:300px;max-width:100%"><option value="">Interfészek betöltése...</option></select>' +
              '</div>' +
              '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
                '<label for="nsCustom">Saját IPv4 tartomány:</label>' +
                '<input id="nsCustom" type="text" placeholder="pl. 10.151.10.0/24 vagy 10.151.10.1-10.151.10.254" style="width:330px;max-width:100%" />' +
              '</div>' +
              '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
                '<label><input type="checkbox" id="nsPorts" checked /> Gyakori TCP portok ellenőrzése</label>' +
                '<button id="nsScanBtn" onclick="pluginHandler.networkscanner.startScan()">Hálózat vizsgálata</button>' +
                '<button onclick="pluginHandler.networkscanner.loadInterfaces()">Interfészek frissítése</button>' +
                '<span id="nsStatus" style="margin-left:4px"></span>' +
              '</div>' +
              '<div id="nsProgressWrap" style="display:none;margin:8px 0 12px 0">' +
                '<div style="height:12px;background:#8884;border-radius:6px;overflow:hidden"><div id="nsProgressBar" style="height:100%;width:0%;background:#1683d8;transition:width .2s"></div></div>' +
                '<div id="nsProgressText" style="font-size:90%;margin-top:4px">0%</div>' +
              '</div>' +
              '<div style="opacity:.75;font-size:90%;margin-bottom:10px">CIDR esetén legfeljebb /20 méretű tartomány adható meg (maximum 4094 használható cím). Csak jogosult hálózatot vizsgálj.</div>' +
              '<div id="nsResults">' + last + '</div>' +
            '</div>');
        h.loadInterfaces();
    };

    obj.esc = function (s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    obj.windowsInterfaceScript = function () {
        return [
            "$ErrorActionPreference='SilentlyContinue'",
            "Get-NetIPConfiguration | ForEach-Object {",
            "  $cfg=$_; $cfg.IPv4Address | ForEach-Object {",
            "    $ip=$_.IPAddress; $prefix=[int]$_.PrefixLength",
            "    if ($ip -and $ip -notlike '169.254.*' -and $ip -ne '127.0.0.1') {",
            "      $bytes=[Net.IPAddress]::Parse($ip).GetAddressBytes(); [Array]::Reverse($bytes)",
            "      $n=[BitConverter]::ToUInt32($bytes,0)",
            "      $mask=if($prefix -eq 0){[uint32]0}else{[uint32]([uint64]4294967295 -shl (32-$prefix))}",
            "      $netBytes=[BitConverter]::GetBytes([uint32]($n -band $mask)); [Array]::Reverse($netBytes)",
            "      $net=([Net.IPAddress]::new($netBytes)).ToString()",
            "      $gw=($cfg.IPv4DefaultGateway | Select-Object -First 1 -ExpandProperty NextHop)",
            "      Write-Output ('NETSCANIF|'+$cfg.InterfaceAlias+'|'+$ip+'|'+$prefix+'|'+$net+'/'+$prefix+'|'+$gw)",
            "    }",
            "  }",
            "}"
        ].join('\r\n');
    };

    obj.linuxInterfaceScript = function () {
        return [
            "command -v ip >/dev/null 2>&1 || { echo 'NETSCANERR|Az ip parancs nem található (iproute2 szükséges).'; exit 0; }",
            "ip -o -4 addr show scope global | while read -r idx iface fam addr rest; do",
            "  ipaddr=${addr%/*}; prefix=${addr#*/}",
            "  case \"$ipaddr\" in 127.*|169.254.*) continue;; esac",
            "  gw=$(ip route show default dev \"$iface\" 2>/dev/null | awk 'NR==1 {for(i=1;i<=NF;i++) if($i==\"via\") print $(i+1)}')",
            "  echo \"NETSCANIF|$iface|$ipaddr|$prefix|$addr|$gw\"",
            "done"
        ].join('\n');
    };

    obj.windowsScanScript = function (cidr, portsEnabled) {
        var safe = String(cidr).replace(/'/g, "''");
        var ports = portsEnabled ? '21,22,23,80,443,445,502,3389,8080,8443,11740' : '';
        return [
            "$ErrorActionPreference='SilentlyContinue'",
            "$target='" + safe + "'",
            "$ports='" + ports + "'",
            "function IpToUInt([string]$s){$b=[Net.IPAddress]::Parse($s).GetAddressBytes();[Array]::Reverse($b);[BitConverter]::ToUInt32($b,0)}",
            "function UIntToIp([uint32]$n){$b=[BitConverter]::GetBytes($n);[Array]::Reverse($b);([Net.IPAddress]::new($b)).ToString()}",
            "try {",
            "  if($target -match '^(.+)/(\\d{1,2})$'){ $base=$Matches[1]; $prefix=[int]$Matches[2]; if($prefix -lt 20 -or $prefix -gt 32){throw 'A CIDR prefix /20 és /32 közötti legyen.'}; $ipn=IpToUInt $base; $mask=[uint32]([uint64]4294967295 -shl (32-$prefix)); $net=[uint32]($ipn -band $mask); $broadcast=[uint32]($net -bor ([uint32]([uint64]4294967295 - $mask))); if($prefix -lt 31){$start=[uint32]($net+1);$end=[uint32]($broadcast-1)}else{$start=$net;$end=$broadcast} }",
            "  elseif($target -match '^(.+)-(.+)$'){ $start=IpToUInt $Matches[1]; $end=IpToUInt $Matches[2]; if($end -lt $start){throw 'A tartomány vége kisebb a kezdeténél.'} }",
            "  else { throw 'CIDR vagy kezdő-vég IP formátum szükséges.' }",
            "  if(([uint64]$end-[uint64]$start) -gt 4093){throw 'Túl nagy tartomány (maximum 4094 cím).'}",
            "  $ips=@(); for([uint64]$i=$start; $i -le $end; $i++){ $ips += (UIntToIp ([uint32]$i)) }",
            "  Write-Output ('NETSCAN|INFO|Tartomány: '+$target+'; vizsgált címek: '+$ips.Count)",
            "  $pingers=@{}; foreach($ip in $ips){try{$p=New-Object Net.NetworkInformation.Ping; $pingers[$ip]=@{p=$p;t=$p.SendPingAsync($ip,650)}}catch{}}",
            "  $tasks=@($pingers.Values | ForEach-Object {$_.t}); if($tasks.Count -gt 0){[void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]$tasks,5000)}",
            "  $alive=@(); foreach($ip in $ips){if($pingers.ContainsKey($ip)){ $t=$pingers[$ip].t; if($t.IsCompleted -and $t.Status -eq 'RanToCompletion' -and $t.Result.Status -eq 'Success'){$alive += $ip} }}",
            "  foreach($ip in $alive){",
            "    $open=@(); if($ports){foreach($port in ($ports -split ',')){ $c=New-Object Net.Sockets.TcpClient; try{$ar=$c.BeginConnect($ip,[int]$port,$null,$null); if($ar.AsyncWaitHandle.WaitOne(180,$false) -and $c.Connected){$open += $port}; $c.EndConnect($ar) 2>$null}catch{}finally{$c.Close()} }}",
            "    if($true){",
            "      $hostName=''; try{$hostName=[Net.Dns]::GetHostEntry($ip).HostName}catch{}",
            "      $mac=''; try{$n=Get-NetNeighbor -IPAddress $ip | Select-Object -First 1; if($n){$mac=$n.LinkLayerAddress}}catch{}",
            "      Write-Output ('NETSCAN|HOST|'+$ip+'|'+$hostName+'|'+$mac+'|'+($open -join ','))",
            "    }",
            "  }",
            "  Write-Output ('NETSCAN|DONE|'+$alive.Count+'|'+$ips.Count)",
            "} catch { Write-Output ('NETSCAN|ERROR|'+$_.Exception.Message) }"
        ].join('\r\n');
    };

    obj.linuxScanScript = function (cidr, portsEnabled) {
        var safe = String(cidr).replace(/'/g, "'\\''");
        var ports = portsEnabled ? '21,22,23,80,443,445,502,3389,8080,8443,11740' : '';
        // Python 3 standard library only; parallel ICMP and TCP checks. No packages installed.
        return [
            "python3 - '" + safe + "' '" + ports + "' <<'PY'",
            "import concurrent.futures, ipaddress, socket, subprocess, sys",
            "target, port_text = sys.argv[1], sys.argv[2]",
            "try:",
            "    if '/' in target:",
            "        net = ipaddress.ip_network(target, strict=False)",
            "        if net.version != 4 or net.prefixlen < 20: raise ValueError('A CIDR prefix /20 és /32 közötti legyen.')",
            "        hosts = list(net.hosts())",
            "    else:",
            "        first, last = target.split('-', 1)",
            "        a, b = ipaddress.ip_address(first), ipaddress.ip_address(last)",
            "        if a.version != 4 or b.version != 4 or int(b) < int(a): raise ValueError('Hibás IPv4 tartomány.')",
            "        if int(b) - int(a) > 4093: raise ValueError('Túl nagy tartomány (maximum 4094 cím).')",
            "        hosts = [ipaddress.ip_address(i) for i in range(int(a), int(b) + 1)]",
            "    if len(hosts) > 4094: raise ValueError('Túl nagy tartomány (maximum 4094 cím).')",
            "except Exception as e:",
            "    print('NETSCAN|ERROR|' + str(e)); sys.exit(0)",
            "ports = [int(x) for x in port_text.split(',') if x]",
            "print('NETSCAN|INFO|Tartomány: %s; vizsgált címek: %d' % (target, len(hosts)))",
            "def probe(ip):",
            "    addr = str(ip); ping_ok = False; opened = []",
            "    try:",
            "        p = subprocess.run(['ping', '-n', '-c', '1', '-W', '1', addr], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)",
            "        ping_ok = (p.returncode == 0)",
            "    except Exception: pass",
            "    for port in ports:",
            "        try:",
            "            with socket.create_connection((addr, port), timeout=0.28): opened.append(port)",
            "        except Exception: pass",
            "    if ping_ok or opened:",
            "        try: hostname = socket.gethostbyaddr(addr)[0]",
            "        except Exception: hostname = ''",
            "        mac = ''",
            "        try:",
            "            n = subprocess.run(['ip', 'neigh', 'show', addr], capture_output=True, text=True, timeout=1).stdout.split()",
            "            if 'lladdr' in n: mac = n[n.index('lladdr') + 1]",
            "        except Exception: pass",
            "        return (addr, hostname, mac, ','.join(map(str, opened)))",
            "    return None",
            "found = []",
            "with concurrent.futures.ThreadPoolExecutor(max_workers=128) as pool:",
            "    for result in pool.map(probe, hosts):",
            "        if result:",
            "            found.append(result)",
            "            print('NETSCAN|HOST|' + '|'.join(result), flush=True)",
            "print('NETSCAN|DONE|%d|%d' % (len(found), len(hosts)))",
            "PY"
        ].join('\n');
    };

    obj.loadInterfaces = function () {
        if (!currentNode || (currentNode.conn & 1) === 0) {
            var s = Q('nsStatus'); if (s) s.textContent = 'Az agent nem kapcsolódik.'; return;
        }
        var node = currentNode, aid = (node.agent != null) ? node.agent.id : 0;
        var isWin = ((aid > 0) && (aid < 5)) || ((aid > 41) && (aid < 44));
        var isUnix = !isWin;
        var h = pluginHandler.networkscanner;
        h.pending = h.pending || {};
        var rid = 'networkscanner:if:' + node._id + ':' + Date.now();
        h.pending[rid] = { kind: 'interfaces', nodeid: node._id, timer: setTimeout(function () {
            if (h.pending[rid]) { delete h.pending[rid]; var st = Q('nsStatus'); if (st) st.textContent = 'Interfész-lekérdezés időtúllépés.'; }
        }, 20000) };
        var st = Q('nsStatus'); if (st) st.textContent = 'Hálózati interfészek lekérdezése...';
        meshserver.send({
            action: 'runcommands', nodeids: [node._id], type: isWin ? 2 : 3,
            cmds: isWin ? h.windowsInterfaceScript() : h.linuxInterfaceScript(),
            runAsUser: 0, reply: true, responseid: rid
        });
    };

    obj.ipToNumber = function (ip) {
        var a = ip.split('.');
        if (a.length !== 4) throw new Error('Hibás IPv4 cím: ' + ip);
        var n = 0;
        for (var i = 0; i < 4; i++) {
            if (!/^\d+$/.test(a[i]) || Number(a[i]) < 0 || Number(a[i]) > 255) throw new Error('Hibás IPv4 cím: ' + ip);
            n = (n * 256) + Number(a[i]);
        }
        return n;
    };

    obj.numberToIp = function (n) {
        return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256,
            Math.floor(n / 256) % 256, n % 256].join('.');
    };

    obj.makeChunks = function (range, chunkSize) {
        var first, last, m = range.match(/^((?:\d{1,3}\.){3}\d{1,3})\/(\d{1,2})$/);
        if (m) {
            var ipn = pluginHandler.networkscanner.ipToNumber(m[1]), prefix = Number(m[2]);
            if (prefix < 20 || prefix > 32) throw new Error('A CIDR prefix /20 és /32 közötti legyen.');
            var size = Math.pow(2, 32 - prefix), net = Math.floor(ipn / size) * size;
            first = (prefix < 31) ? net + 1 : net;
            last = (prefix < 31) ? net + size - 2 : net + size - 1;
        } else {
            var a = range.split('-');
            first = pluginHandler.networkscanner.ipToNumber(a[0]);
            last = pluginHandler.networkscanner.ipToNumber(a[1]);
            if (last < first) throw new Error('A tartomány vége kisebb a kezdeténél.');
        }
        if (last - first + 1 > 4094) throw new Error('Túl nagy tartomány (maximum 4094 cím).');
        var chunks = [];
        for (var n = first; n <= last; n += chunkSize) {
            chunks.push(pluginHandler.networkscanner.numberToIp(n) + '-' +
                pluginHandler.networkscanner.numberToIp(Math.min(last, n + chunkSize - 1)));
        }
        return { chunks: chunks, total: last - first + 1 };
    };

    obj.sendScanChunk = function (scan) {
        var h = pluginHandler.networkscanner;
        if (scan.cancelled) return;
        if (scan.index >= scan.chunks.length) {
            h.finishScan(scan);
            return;
        }
        var rid = scan.id + ':' + scan.index;
        var chunk = scan.chunks[scan.index];
        h.pending[rid] = {
            kind: 'scanChunk', scan: scan,
            timer: setTimeout(function () {
                if (h.pending[rid]) {
                    delete h.pending[rid];
                    scan.error = 'Időtúllépés ennél a rész-tartománynál: ' + chunk;
                    scan.cancelled = true;
                    h.finishScan(scan);
                }
            }, 90000)
        };
        var pct = Math.floor((scan.done / scan.total) * 100);
        var st = Q('nsStatus'), txt = Q('nsProgressText');
        if (st) st.textContent = 'Vizsgálat: ' + chunk + ' (' + (scan.index + 1) + '/' + scan.chunks.length + ')';
        if (txt) txt.textContent = pct + '% — ' + scan.done + ' / ' + scan.total + ' cím';
        meshserver.send({
            action: 'runcommands', nodeids: [scan.nodeid], type: scan.isWin ? 2 : 3,
            cmds: scan.isWin ? h.windowsScanScript(chunk, scan.ports) : h.linuxScanScript(chunk, scan.ports),
            runAsUser: 0, reply: true, responseid: rid
        });
    };

    obj.finishScan = function (scan) {
        var h = pluginHandler.networkscanner, btn = Q('nsScanBtn'), status = Q('nsStatus');
        if (btn) btn.disabled = false;
        var wrap = Q('nsProgressWrap'), bar = Q('nsProgressBar'), txt = Q('nsProgressText');
        var pct = Math.floor((scan.done / scan.total) * 100);
        if (bar) bar.style.width = pct + '%';
        if (txt) txt.textContent = pct + '% — ' + scan.done + ' / ' + scan.total + ' cím';
        if (wrap) wrap.style.display = 'block';
        var unique = {};
        scan.hosts.forEach(function (host) { unique[host.ip] = host; });
        var hosts = Object.keys(unique).map(function (ip) { return unique[ip]; });
        var html = h.renderResults(hosts, 'Vizsgált címek: ' + scan.done + ' / ' + scan.total +
            (scan.error ? ' — ' + scan.error : ''), scan.name, scan.range);
        if (scan.error) html = '<div style="color:#c00;margin:6px 0">' + h.esc(scan.error) + '</div>' + html;
        h.last = h.last || {};
        h.last[scan.nodeid] = html;
        var box = Q('nsResults');
        if (box && currentNode && currentNode._id === scan.nodeid) box.innerHTML = html;
        if (status) status.textContent = scan.error ? 'Megszakadt: ' + scan.error : 'Kész: ' + hosts.length + ' eszköz';
        if (bar) bar.style.width = (scan.error ? pct : 100) + '%';
    };

    obj.startScan = function () {
        if (!currentNode || (currentNode.conn & 1) === 0) {
            var s = Q('nsStatus'); if (s) s.textContent = 'Az agent nem kapcsolódik.'; return;
        }
        var node = currentNode, aid = (node.agent != null) ? node.agent.id : 0;
        var isWin = ((aid > 0) && (aid < 5)) || ((aid > 41) && (aid < 44));
        var custom = Q('nsCustom'), select = Q('nsInterface'), ports = Q('nsPorts');
        var range = (custom && custom.value.trim()) ? custom.value.trim() : (select ? select.value : '');
        if (!range) { Q('nsStatus').textContent = 'Válassz interfészt vagy adj meg saját tartományt.'; return; }
        var chunks;
        try { chunks = pluginHandler.networkscanner.makeChunks(range, 128); }
        catch (ex) { Q('nsStatus').textContent = ex.message; return; }
        var h = pluginHandler.networkscanner;
        h.pending = h.pending || {};
        var scan = {
            id: 'networkscanner:scan:' + node._id + ':' + Date.now(),
            nodeid: node._id, name: node.name, range: range, isWin: isWin,
            ports: !!(ports && ports.checked), chunks: chunks.chunks,
            total: chunks.total, done: 0, index: 0, hosts: [], cancelled: false, error: ''
        };
        var btn = Q('nsScanBtn'); if (btn) btn.disabled = true;
        var wrap = Q('nsProgressWrap'), bar = Q('nsProgressBar'), txt = Q('nsProgressText');
        if (wrap) wrap.style.display = 'block';
        if (bar) bar.style.width = '0%';
        if (txt) txt.textContent = '0% — 0 / ' + scan.total + ' cím';
        h.sendScanChunk(scan);
    };

    obj.ouiVendors = {
        '000C29':'VMware', '005056':'VMware', '000569':'VMware',
        '080027':'Oracle VirtualBox', '001C42':'Parallels',
        'B827EB':'Raspberry Pi', 'DCA632':'Raspberry Pi', 'E45F01':'Raspberry Pi',
        'DC:A6:32':'Raspberry Pi', '2C:CF:67':'Raspberry Pi',
        '001B21':'Intel', '3C:FD:FE':'Intel', 'A4:4C:C8':'Intel',
        '001B63':'Apple', '3C:22:FB':'Apple', 'F0:18:98':'Apple',
        '001A2B':'Cisco', '000C85':'Cisco', '001B0C':'Cisco', '00:1E:49':'Cisco',
        '001E65':'Samsung', '002454':'Samsung', '8C:77:12':'Samsung',
        '001A11':'Google', 'F4:F5:D8':'Google',
        '001D7E':'Hewlett Packard Enterprise', '3C:D9:2B':'HPE', '00:1F:29':'HPE',
        '001E0B':'Dell', '002219':'Dell', 'F8:BC:12':'Dell',
        '001B78':'HP', '3C:52:82':'HP',
        '001F16':'Microsoft', '7C:1E:52':'Microsoft',
        '00155D':'Microsoft Hyper-V', '00:15:5D':'Microsoft Hyper-V',
        '0003FF':'Microsoft', '001DD8':'Microsoft',
        '001B17':'Huawei', '002568':'Huawei', '48:46:FB':'Huawei',
        '001E10':'TP-Link', '50:C7:BF':'TP-Link', 'B0:BE:76':'TP-Link',
        '001F1F':'D-Link', '1C:7E:E5':'D-Link', 'C8:BE:19':'D-Link',
        '0018F8':'Zyxel', 'A4:2B:B0':'Zyxel',
        '000F66':'Netgear', '2C:30:33':'Netgear', 'A0:04:60':'Netgear',
        '001B2F':'Moxa', '00090F':'Moxa', '00:90:E8':'Moxa',
        '0001C1':'Cisco-Linksys', '001217':'Cisco-Linksys',
        '0013C4':'Schneider Electric', '00:80:F4':'Schneider Electric',
        '001A06':'WAGO', '00:30:DE':'WAGO',
        '0001B5':'Siemens', '001B1B':'Siemens', '00:0E:8C':'Siemens',
        '001C06':'ABB', '00:1A:2B':'ABB',
        '001D9C':'Advantech', '00:D0:C9':'Advantech',
        '000A5E':'Mitsubishi Electric', '00:0C:FA':'Mitsubishi Electric',
        '000E8C':'Siemens', '0010F3':'TP-Link'
    };

    obj.getVendor = function (mac) {
        if (!mac) return '';
        var clean = String(mac).toUpperCase().replace(/[^0-9A-F]/g, '');
        if (clean.length < 6) return '';
        var key = clean.substring(0, 6);
        var map = obj.ouiVendors;
        return map[key] || map[key.substring(0,2)+':'+key.substring(2,4)+':'+key.substring(4,6)] || 'Ismeretlen OUI';
    };

    obj.renderResults = function (hosts, info, name, range) {
        var e = pluginHandler.networkscanner.esc;
        var out = '<div style="margin:8px 0"><b>' + e(name) + '</b> — ' + e(range) + ' — ' + e(new Date().toLocaleString()) + '</div>';
        if (info) out += '<div style="margin:6px 0">' + e(info) + '</div>';
        if (!hosts.length) return out + '<p>Nem találtam ICMP-re válaszoló vagy a vizsgált TCP portok valamelyikén elérhető eszközt.</p>';
        out += '<div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%"><thead><tr>' +
            ['IP-cím', 'Gépnév / DNS', 'MAC-cím', 'Gyártó (OUI)', 'Nyitott TCP portok'].map(function (x) {
                return '<th style="text-align:left;padding:6px;border:1px solid #8886">' + x + '</th>';
            }).join('') + '</tr></thead><tbody>';
        hosts.forEach(function (h) {
            out += '<tr>' + [h.ip, h.name || '—', h.mac || '—', pluginHandler.networkscanner.getVendor(h.mac) || '—', h.ports || '—'].map(function (x) {
                return '<td style="padding:6px;border:1px solid #8886">' + e(x) + '</td>';
            }).join('') + '</tr>';
        });
        return out + '</tbody></table><div style="margin-top:6px">Talált eszközök: ' + hosts.length + '</div></div>';
    };

    obj.onResult = function (message) {
        var h = pluginHandler.networkscanner;
        var p = h.pending ? h.pending[message.responseid] : null;
        if (!p) return;
        clearTimeout(p.timer);
        delete h.pending[message.responseid];
        var result = (typeof message.result === 'string') ? message.result : '';
        if (p.kind === 'interfaces') {
            var sel = Q('nsInterface'), status = Q('nsStatus'), options = [];
            result.split(/\r?\n/).forEach(function (line) {
                if (line.indexOf('NETSCANIF|') === 0) {
                    var a = line.split('|');
                    options.push({ label: a[1] + ' — ' + a[2] + '/' + a[3] + (a[5] ? ' (GW: ' + a[5] + ')' : ''), value: a[4] });
                }
            });
            if (sel) {
                sel.innerHTML = '';
                if (!options.length) {
                    var empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Nem található IPv4 interfész'; sel.appendChild(empty);
                }
                options.forEach(function (o, i) {
                    var opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label;
                    sel.appendChild(opt); if (i === 0) opt.selected = true;
                });
            }
            if (status) {
                var err = result.split(/\r?\n/).filter(function (x) { return x.indexOf('NETSCANERR|') === 0; })[0];
                status.textContent = err ? err.substring(11) : (options.length ? 'Interfészek: ' + options.length : 'Nem érkezett interfészadat.');
            }
            return;
        }
        if (p.kind === 'scanChunk') {
            var scan = p.scan, chunkHosts = [], chunkError = '';
            result.split(/\r?\n/).forEach(function (line) {
                if (line.indexOf('NETSCAN|ERROR|') === 0) chunkError = line.substring(14);
                else if (line.indexOf('NETSCAN|HOST|') === 0) {
                    var a = line.split('|');
                    chunkHosts.push({ ip: a[2] || '', name: a[3] || '', mac: a[4] || '', ports: a[5] || '' });
                }
            });
            if (chunkError) {
                scan.error = chunkError;
                scan.cancelled = true;
            } else {
                scan.hosts = scan.hosts.concat(chunkHosts);
                var bounds = scan.chunks[scan.index].split('-');
                scan.done += pluginHandler.networkscanner.ipToNumber(bounds[1]) -
                    pluginHandler.networkscanner.ipToNumber(bounds[0]) + 1;
                scan.index++;
            }
            var pct = Math.floor((scan.done / scan.total) * 100);
            var bar = Q('nsProgressBar'), txt = Q('nsProgressText');
            if (bar) bar.style.width = pct + '%';
            if (txt) txt.textContent = pct + '% — ' + scan.done + ' / ' + scan.total + ' cím — találat: ' + scan.hosts.length;
            if (scan.cancelled || scan.index >= scan.chunks.length) h.finishScan(scan);
            else h.sendScanChunk(scan);
            return;
        }
        var btn = Q('nsScanBtn'), status = Q('nsStatus'), box = Q('nsResults');
        if (btn) btn.disabled = false;
        var hosts = [], info = '', error = '';
        result.split(/\r?\n/).forEach(function (line) {
            if (line.indexOf('NETSCAN|INFO|') === 0) info = line.substring(13);
            else if (line.indexOf('NETSCAN|ERROR|') === 0) error = line.substring(14);
            else if (line.indexOf('NETSCAN|HOST|') === 0) {
                var a = line.split('|');
                hosts.push({ ip: a[2] || '', name: a[3] || '', mac: a[4] || '', ports: a[5] || '' });
            }
        });
        var html = error ? '<div style="color:#c00">' + h.esc(error) + '</div>' :
            (hosts.length || info ? h.renderResults(hosts, info, p.name, p.range) :
                '<div style="color:#c00">Nem érkezett értékelhető válasz az agenttől.</div><pre>' + h.esc(result) + '</pre>');
        h.last = h.last || {};
        h.last[p.nodeid] = html;
        if (box && currentNode && currentNode._id === p.nodeid) box.innerHTML = html;
        if (status) status.textContent = error ? 'Hiba' : ('Kész: ' + hosts.length + ' eszköz');
    };

    return obj;
};
