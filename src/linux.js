const { Client } = require('ssh2');
const fs = require('fs');
const os = require('os');

function expandPath(p) {
  if (!p) return p;
  return p.replace(/^~/, os.homedir());
}

function sshExec(serverConfig, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';

    const connectConfig = {
      host: serverConfig.host,
      port: serverConfig.port || 22,
      username: serverConfig.user,
      readyTimeout: 10000,
    };

    if (serverConfig.privateKey) {
      try {
        connectConfig.privateKey = fs.readFileSync(expandPath(serverConfig.privateKey));
      } catch {
        return reject(new Error(`SSH key not found: ${serverConfig.privateKey}`));
      }
    } else if (serverConfig.password) {
      connectConfig.password = serverConfig.password;
    }

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        stream.on('data', d => { output += d.toString(); });
        stream.stderr.on('data', d => { output += d.toString(); });
        stream.on('close', () => { conn.end(); resolve(output.trim()); });
      });
    });

    conn.on('error', reject);
    conn.connect(connectConfig);
  });
}

const linuxHistory = new Map();

async function getServerData(serverConfig) {
  const serviceNames = serverConfig.services || [];
  const quoted = serviceNames.map(s => `'${s}'`).join(' ');
  const svcCmd = serviceNames.length ? `systemctl is-active ${quoted} 2>/dev/null; true` : 'true';
  const statsCmd = `CPUIDLE=$(top -bn1 | grep -E '^(%Cpu|Cpu)' | sed 's/,/ /g' | awk '{for(i=1;i<=NF;i++){if($i=="id"){print 100-$(i-1);exit}}}'); free -k | awk -v cpu="\${CPUIDLE:-0}" '/^Mem:/{printf "%.0f|%.0f|%.2f|%.2f",cpu+0,$3*100/$2,$3/1048576,$2/1048576}'`;
  const command = `${svcCmd}; echo "---STATS---"; ${statsCmd}`;

  try {
    const output = await sshExec(serverConfig, command);
    const sepIdx = output.indexOf('---STATS---');
    const svcPart   = sepIdx >= 0 ? output.slice(0, sepIdx) : output;
    const statsPart = sepIdx >= 0 ? output.slice(sepIdx + 11) : '';

    const lines = svcPart.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const services = serviceNames.map((name, i) => {
      const state = lines[i] || 'unknown';
      return { name, state, active: state === 'active' };
    });

    const parts = statsPart.trim().split('|');
    const cpu = parts[0] != null && parts[0] !== '' ? Math.min(100, Math.max(0, Math.round(parseFloat(parts[0])))) : null;
    const ram = parts[1] != null && parts[1] !== '' ? {
      percent: Math.min(100, Math.max(0, Math.round(parseFloat(parts[1])))),
      usedGB:  parseFloat(parts[2]).toFixed(1),
      totalGB: parseFloat(parts[3]).toFixed(1),
    } : null;

    const hist = linuxHistory.get(serverConfig.host) || [];
    if (cpu != null) {
      hist.push({ time: Date.now(), cpu, ram: ram?.percent ?? 0 });
      if (hist.length > 240) hist.shift();
      linuxHistory.set(serverConfig.host, hist);
    }

    return { name: serverConfig.name, host: serverConfig.host, online: true, services, cpu, ram, history: [...hist] };
  } catch (err) {
    return {
      name: serverConfig.name,
      host: serverConfig.host,
      online: false,
      error: err.message,
      services: serviceNames.map(s => ({ name: s, state: 'unknown', active: false })),
    };
  }
}

async function getAllLinuxData(config) {
  const servers = config.servers || [];
  const results = await Promise.allSettled(servers.map(getServerData));
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          name: servers[i].name,
          host: servers[i].host,
          online: false,
          error: r.reason?.message,
          services: (servers[i].services || []).map(s => ({ name: s, state: 'unknown', active: false })),
        }
  );
}

module.exports = { getAllLinuxData };
