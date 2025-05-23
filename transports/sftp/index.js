/* index.js – Node-RED SFTP node  (cwd, upload, restore, toggleable logging) */
/* Toggle verbose logs:  export SFTP_VERBOSE=1  */

const fs   = require('fs');
const path = require('path');
const SFTP = require('ssh2-sftp-client');

module.exports = function (RED) {
  'use strict';

  const VERBOSE = /^1|true$/i.test(process.env.SFTP_VERBOSE || '');

  function log(node, msg) { if (VERBOSE) node.warn(msg); }

  /* ───────────── CONFIG NODE ───────────── */
  function SFTPCredentials(cfg) {
    RED.nodes.createNode(this, cfg);
    this.host     = cfg.host;
    this.port     = cfg.port;
    this.username = cfg.username;
    this.password = cfg.password;
    this.key      = cfg.key;
    this._client  = null;                // shared connection
  }

  const credSchema = {
    credentials: {
      username:   { type: 'text' },
      password:   { type: 'password' },
      keydata:    { type: 'text' },
      passphrase: { type: 'password' }
    }
  };

  RED.nodes.registerType('SFTP-credentials', SFTPCredentials, credSchema);
  RED.nodes.registerType('sftp', SFTPCredentials, credSchema);          // alias

  /* ───────────── FLOW NODE ───────────── */
  function SFtpNode(n) {
    RED.nodes.createNode(this, n);

    const node = this;
    node.operation = n.operation || 'list';
    node.filename  = n.filename  || '';
    node.workdir   = n.workdir   || '.';
    node.cfg       = RED.nodes.getNode(n.sftp);

    if (!node.cfg) { node.error('SFTP: configuration node missing'); return; }

    node.on('input', async (msg, send, done) => {
      const opts = {
        host:     msg.host     || node.cfg.host     || 'localhost',
        port:     msg.port     || node.cfg.port     || 22,
        username: msg.user     || node.cfg.username || node.cfg.credentials.username,
        password: msg.password || node.cfg.password || node.cfg.credentials.password,
        debug:    t => log(node, `[ssh2] ${t}`)
      };
      if (msg.key || node.cfg.key || node.cfg.credentials.keydata)
        opts.privateKey = msg.key || node.cfg.key || node.cfg.credentials.keydata;
      if (node.cfg.credentials.passphrase)
        opts.passphrase = node.cfg.credentials.passphrase;

      /* connect (reuse) */
      let sftp = node.cfg._client;
      if (!sftp) {
        node.status({ fill: 'blue', shape: 'dot', text: 'connect' });
        log(node, `[flow] connecting to ${opts.username}@${opts.host}:${opts.port}`);
        sftp = new SFTP();
        await sftp.connect(opts);
        node.cfg._client = sftp;
        node.status({});
      }

      try {
        const workdir = msg.workdir || node.workdir || '.';
        let   rFile   = msg.filename || node.filename;
        const prevDir = await sftp.cwd();               // save current dir
        log(node, `[paths] prevDir=${prevDir} workdir=${workdir} filename=${rFile}`);

        /* ────────── PUT ────────── */
        if (node.operation === 'put') {
          let src = msg.payload;
          if (src && typeof src === 'object' && 'data' in src) { // legacy
            if (src.filename) rFile = src.filename;
            src = src.data;
            log(node, '[put] legacy {filename,data} detected');
          }
          if (rFile.startsWith('/')) rFile = rFile.slice(1);

          await sftp.mkdir(workdir, true).catch(() => {});
          await sftp.cwd(workdir);                       // cd into target dir

          const expect =
            typeof src === 'string' && fs.existsSync(src) ? fs.statSync(src).size :
            Buffer.isBuffer(src)                          ? src.length            :
                                                            null;

          log(node, `[put] uploading → ${rFile} (expect ${expect ?? 'unknown'} bytes)`);
          node.status({ fill: 'yellow', shape: 'dot', text: 'uploading' });

          if (typeof src === 'string' && fs.existsSync(src)) {
            await sftp.fastPut(src, rFile, { concurrency: 1 });
          } else {
            await sftp.put(src, rFile, { concurrency: 1, rejectOnError: true });
          }

          const st = await sftp.stat(rFile).catch(() => ({ size: -1 }));
          log(node, `[put] remote size = ${st.size}`);
          if (expect !== null && st.size !== expect)
            throw new Error(`size mismatch: expected ${expect}, got ${st.size}`);

          msg.payload = { ok: true, path: path.posix.join(workdir, rFile), size: st.size };
          node.status({});

          await sftp.cwd(prevDir);                       // restore dir
          send(msg); done && done();
          return;
        }

        /* ───── other operations ───── */
        const p = x => path.posix.join(workdir, x);
        switch (node.operation) {
          case 'list':   msg.payload = await sftp.list(workdir); break;
          case 'get':    msg.payload = await sftp.get(p(rFile)); break;
          case 'delete': await sftp.delete(p(rFile)); msg.payload={deleted:rFile}; break;
          case 'mkdir':  await sftp.mkdir(workdir, false); msg.payload={created:workdir}; break;
          case 'rmdir':  await sftp.rmdir(workdir, false); msg.payload={removed:workdir}; break;
          case 'close':  await sftp.end(); node.cfg._client=null; msg.payload={closed:true}; break;
          default:       throw new Error(`unknown op ${node.operation}`);
        }

        send(msg); done && done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
        log(node, `[error] ${err.message}`);
        node.error(err, msg); done && done(err);
      }
    });
  }

  RED.nodes.registerType('sftp in', SFtpNode, {
    credentials: { username:{type:'text'}, password:{type:'password'} }
  });
};
