let pg = null;
let mysql = null;
let mongo = null;
try { pg = require('pg'); } catch {}
try { mysql = require('mysql2/promise'); } catch {}
try { mongo = require('mongodb'); } catch {}

async function probePostgres(db) {
  const { Client } = pg;
  const client = new Client({
    host: db.host,
    port: db.port || 5432,
    user: db.user,
    password: db.password,
    database: db.database || 'postgres',
    connectionTimeoutMillis: 8000,
    statement_timeout: 8000,
    ssl: db.ssl ? { rejectUnauthorized: db.rejectUnauthorized !== false } : undefined,
  });
  await client.connect();
  try {
    const conns = await client.query('SELECT count(*)::int AS c FROM pg_stat_activity').catch(() => null);
    const maxc = await client.query("SELECT setting::int AS m FROM pg_settings WHERE name='max_connections'").catch(() => null);
    const size = await client.query('SELECT pg_database_size(current_database())::bigint AS s').catch(() => null);
    const ver = await client.query('SHOW server_version').catch(() => null);
    return {
      online: true,
      connections: conns?.rows?.[0]?.c ?? null,
      maxConnections: maxc?.rows?.[0]?.m ?? null,
      sizeBytes: size?.rows?.[0]?.s != null ? Number(size.rows[0].s) : null,
      version: ver?.rows?.[0]?.server_version || null,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function probeMysql(db) {
  const conn = await mysql.createConnection({
    host: db.host,
    port: db.port || 3306,
    user: db.user,
    password: db.password,
    database: db.database || undefined,
    connectTimeout: 8000,
    ssl: db.ssl ? { rejectUnauthorized: db.rejectUnauthorized !== false } : undefined,
  });
  try {
    const [tc] = await conn.query("SHOW STATUS LIKE 'Threads_connected'").catch(() => [[]]);
    const [mc] = await conn.query("SHOW VARIABLES LIKE 'max_connections'").catch(() => [[]]);
    const [sz] = await conn.query('SELECT SUM(data_length + index_length) AS s FROM information_schema.tables').catch(() => [[]]);
    const [vr] = await conn.query("SHOW VARIABLES LIKE 'version'").catch(() => [[]]);
    return {
      online: true,
      connections: tc?.[0]?.Value != null ? Number(tc[0].Value) : null,
      maxConnections: mc?.[0]?.Value != null ? Number(mc[0].Value) : null,
      sizeBytes: sz?.[0]?.s != null ? Number(sz[0].s) : null,
      version: vr?.[0]?.Value || null,
    };
  } finally {
    await conn.end().catch(() => {});
  }
}

async function probeMongo(db) {
  const { MongoClient } = mongo;
  const auth = db.user ? `${encodeURIComponent(db.user)}:${encodeURIComponent(db.password || '')}@` : '';
  const uri = `mongodb://${auth}${db.host}:${db.port || 27017}/${db.database || 'admin'}`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
  await client.connect();
  try {
    const admin = client.db().admin();
    let connections = null, maxConnections = null, version = null, sizeBytes = null;
    try {
      const ss = await admin.serverStatus();
      connections = ss?.connections?.current ?? null;
      if (ss?.connections?.current != null && ss?.connections?.available != null) maxConnections = ss.connections.current + ss.connections.available;
      version = ss?.version || null;
    } catch {}
    try {
      const ld = await admin.command({ listDatabases: 1 });
      sizeBytes = ld?.totalSize != null ? Number(ld.totalSize) : null;
    } catch {
      try { const st = await client.db(db.database || 'admin').command({ dbStats: 1 }); sizeBytes = st?.dataSize != null ? Number(st.dataSize) : null; } catch {}
    }
    return { online: true, connections, maxConnections, sizeBytes, version };
  } finally {
    await client.close().catch(() => {});
  }
}

async function getDbData(db) {
  const type = String(db.type || '').toLowerCase();
  try {
    let r;
    if (type === 'postgresql' || type === 'postgres') {
      if (!pg) throw new Error('pg driver not installed (run npm install)');
      r = await probePostgres(db);
    } else if (type === 'mysql' || type === 'mariadb') {
      if (!mysql) throw new Error('mysql2 driver not installed (run npm install)');
      r = await probeMysql(db);
    } else if (type === 'mongodb' || type === 'mongo') {
      if (!mongo) throw new Error('mongodb driver not installed (run npm install)');
      r = await probeMongo(db);
    } else {
      throw new Error('unsupported type: ' + db.type);
    }
    return { name: db.name, type, host: db.host, ...r };
  } catch (e) {
    return { name: db.name, type, host: db.host, online: false, error: e.message };
  }
}

async function getAllDatabaseData(config) {
  const list = (config && config.instances) || [];
  const results = await Promise.allSettled(list.map(getDbData));
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { name: list[i].name, type: list[i].type, host: list[i].host, online: false, error: r.reason?.message }
  );
}

module.exports = { getAllDatabaseData };
