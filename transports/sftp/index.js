// index.js  –  Node-RED SFTP node with detailed logging
// Works with ssh2-sftp-client v11 or v12 (Node 18/20)

const fs   = require('fs');
const path = require('path');
const SFTP = require('ssh2-sftp-client');

module.exports = function (RED) {
  'use strict';

  /***************** CONFIG NODE – stores creds + shared client ***************/
  function SFTPCredentials (config) {
    RED.nodes.createNode(this, config);
    this.host     = config.host;
    this.port     = config.port;
    this.username = config.username;
    this.password = config.password;
    this.key      = config.key;
    this._client  = null;            // reused by multiple flow nodes
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
  RED.nodes.registerType('sftp',               SFTPCredentials, credSchema); // alias

  /*************************** MAIN IN/OUT NODE *******************************/
  function SFtpNode (n) {
    RED.nodes.createNode(this, n);

    const node = this;
    node.operation = n.operation || 'list';
    node.filename  = n.filename  || '';
    node.workdir   = n.workdir   || '.';
    node.cfg       = RED.nodes.getNode(n.sftp);

    if (!node.cfg) {
      node.error('SFTP: configuration node missing');
      return;
    }

    node.on('input', async (msg, send, done) => {
      /* resolve credentials */
      const opts = {
        host:       msg.host     || node.cfg.host     || 'localhost',
        port:       msg.port     || node.cfg.port     || 22,
        username:   msg.user     || node.cfg.username || node.cfg.credentials.username,
        password:   msg.password || node.cfg.password || node.cfg.credentials.password,
        debug:      t => node.warn(`[ssh2] ${t}`)
      };
      if (msg.key || node.cfg.key || node.cfg.credentials.keydata)
        opts.privateKey = msg.key || node.cfg.key || node.cfg.credentials.keydata;
      if (node.cfg.credentials.passphrase)
        opts.passphrase = node.cfg.credentials.passphrase;

      /* connect or reuse */
      let sftp = node.cfg._client;
      if (!sftp) {
        node.status({ fill: 'blue', shape: 'dot', text: 'connect' });
        node.warn(`[flow] connecting to ${opts.username}@${opts.host}:${opts.port}`);
        sftp = new SFTP();
        await sftp.connect(opts);
        node.cfg._client = sftp;
        node.status({});
      }

      const pJoin = (...a) => path.posix.join(...a);

      try {
        const workdir = msg.workdir || node.workdir  || '.';
        let   rFile   = msg.filename || node.filename;
        const prevDir = await sftp.cwd();

        node.warn(`[paths] prevDir=${prevDir} workdir=${workdir} filename=${rFile}`);

        /* PUT branch (all other ops fall through later) */
        if (node.operation === 'put') {
          // legacy {filename,data}
          let src = msg.payload;
          if (src && typeof src === 'object' && 'data' in src) {
            if (src.filename) rFile = src.filename;
            src = src.data;
            node.warn('[put] legacy {filename,data} detected');
          }

          if (rFile.startsWith('/')) {
            node.warn(`[put] stripping leading / → ${rFile.slice(1)}`);
            rFile = rFile.slice(1);
          }
          const remotePath = pJoin(workdir, rFile);

          /* ensure directory exists */
          try { await sftp.mkdir(workdir, true); }
          catch (e) { node.warn(`[put] mkdir skipped: ${e.message}`); }

          /* expected size for verify */
          let expect = null;
          if (typeof src === 'string' && fs.existsSync(src))
            expect = fs.statSync(src).size;
          else if (Buffer.isBuffer(src))
            expect = src.length;

          node.warn(`[put] final remote path = ${remotePath} (expect ${expect ?? 'unknown'} bytes)`);
          node.status({ fill: 'yellow', shape: 'dot', text: 'uploading' });

          /* choose upload API */
          if (typeof src === 'string' && fs.existsSync(src)) {
            // fastPut path→path avoids early FSETSTAT
            await sftp.fastPut(src, remotePath, { mkdir: true });
          } else {
            await sftp.put(src, remotePath, { rejectOnError: true });
          }

          /* verify */
          const st = await sftp.stat(remotePath).catch(() => ({ size: -1 }));
          node.warn(`[put] remote size = ${st.size}`);
          if (expect !== null && st.size !== expect)
            throw new Error(`size mismatch: expected ${expect}, got ${st.size}`);

          msg.payload = { ok: true, path: remotePath, size: st.size };
          node.status({});
          send(msg); done && done();
          return;
        }

        /************** other operations ************************************/
        switch (node.operation) {
          case 'list':   msg.payload = await sftp.list(workdir); break;
          case 'get':    msg.payload = await sftp.get(pJoin(workdir, rFile)); break;
          case 'delete': await sftp.delete(pJoin(workdir, rFile)); msg.payload={deleted:rFile}; break;
          case 'mkdir':  await sftp.mkdir(workdir, false); msg.payload={created:workdir}; break;
          case 'rmdir':  await sftp.rmdir(workdir, false); msg.payload={removed:workdir}; break;
          case 'close':  await sftp.end(); node.cfg._client=null; msg.payload={closed:true}; break;
          default:       throw new Error(`unknown op ${node.operation}`);
        }

        send(msg); done && done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
        node.warn(`[error] ${err.message}`);
        node.error(err, msg); done && done(err);
      }
    });
  }

  RED.nodes.registerType('sftp in', SFtpNode, {
    credentials: { username:{type:'text'}, password:{type:'password'} }
  });
};
