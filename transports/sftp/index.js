/* index.js – Node-RED SFTP node
 *  • explicit open/close OR automatic per-message
 *  • msg.payload string can override paths for list/get/delete/mkdir/rmdir
 *  • delete ⇒ payload === "Successfully deleted"
 *  • per-credentials queue avoids overlapping SFTP requests
 *  • verbose logs:  export SFTP_VERBOSE=1
 */

const fs   = require('fs');
const path = require('path');
const SFTP = require('ssh2-sftp-client');

module.exports = function (RED) {
  'use strict';

  /* ─ helpers ─ */
  const VERBOSE = /^1|true$/i.test(process.env.SFTP_VERBOSE || '');
  const log     = (node, m) => { if (VERBOSE) node.warn(m); };

  /* ─ credentials node ─ */
  function SFTPCredentials(cfg) {
    RED.nodes.createNode(this, cfg);
    this.host     = cfg.host;
    this.port     = cfg.port;
    this.username = cfg.username;
    this.password = cfg.password;
    this.key      = cfg.key;
    this._client  = null;               // cached ssh2-sftp-client
    this._busy    = Promise.resolve();  // serialises ops
  }

  RED.nodes.registerType(
    'SFTP-credentials',
    SFTPCredentials,
    { credentials: {
        username:   {type:'text'},
        password:   {type:'password'},
        keydata:    {type:'text'},
        passphrase: {type:'password'}
      }
    });
  RED.nodes.registerType('sftp', SFTPCredentials);  // alias

  /* ─ flow node ─ */
  function SFtpNode(n) {
    RED.nodes.createNode(this, n);

    const node = this;
    node.operation = n.operation || 'list';
    node.filename  = n.filename  || '';
    node.workdir   = n.workdir   || '.';
    node.cfg       = RED.nodes.getNode(n.sftp);

    if (!node.cfg) { node.error('SFTP: missing configuration node'); return; }

    /* ----- main handler (queued) ----- */
    node.on('input', (msg, send, done) => {
      node.cfg._busy =
        node.cfg._busy.then(() => run(msg, send, done))
                      .catch(() => {/* already handled */});
    });

    async function run (msg, send, done) {
      /* 1 ─ connection opts */
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

      /* 2 ─ connect or reuse */
      let sftp       = node.cfg._client;
      const hadCache = !!sftp;

      if (!sftp) {
        node.status({fill:'blue',shape:'dot',text:'connect'});
        sftp = new SFTP();
        try {
          await sftp.connect(opts);
          if (node.operation === 'open') node.cfg._client = sftp;
        } catch (err) {
          node.status({fill:'red',shape:'ring',text:'connect fail'});
          node.error(err, msg); done && done(err); return;
        } finally { node.status({}); }
      }

      /* helper: treat string payload as override path */
      const payloadPath =
        typeof msg.payload === 'string' && msg.payload.trim().length
          ? msg.payload.trim()
          : null;

      try {
        node.status({fill:'yellow',shape:'dot',text:node.operation});

        /* derive dir/file */
        const workdir = payloadPath || msg.workdir || node.workdir || '.';
        let   rFile   = msg.filename || node.filename;
        if ((node.operation === 'get' || node.operation === 'delete') && payloadPath)
          rFile = path.posix.basename(payloadPath);

        const remote = f => path.posix.join(workdir, f);

        switch (node.operation) {
          /* ---- session ---- */
          case 'open':
            break;

          case 'close':
            await sftp.end();
            node.cfg._client = null;
            msg.payload = 'closed';
            break;

          /* ---- directory ---- */
          case 'list':
            msg.payload = await sftp.list(workdir);
            break;

          case 'mkdir':
            await sftp.mkdir(workdir, false);
            msg.payload = {created: workdir};
            break;

          case 'rmdir':
            await sftp.rmdir(workdir, false);
            msg.payload = {removed: workdir};
            break;

          /* ---- file ---- */
          case 'get':
            msg.payload = await sftp.get(payloadPath ? workdir : remote(rFile));
            break;

          case 'delete':
            await sftp.delete(payloadPath ? workdir : remote(rFile));
            msg.remotePath = payloadPath ? workdir : remote(rFile); // optional extra info
            msg.payload    = 'Successfully deleted';
            break;

          case 'put': {
            let src = msg.payload;
            if (src && typeof src === 'object' && 'data' in src) {
              if (src.filename) rFile = src.filename;
              src = src.data;
            }
            if (rFile.startsWith('/')) rFile = rFile.slice(1);

            await sftp.mkdir(workdir, true).catch(() => {});
            await sftp.cwd(workdir);

            const exp =
              typeof src === 'string' && fs.existsSync(src) ? fs.statSync(src).size :
              Buffer.isBuffer(src)                          ? src.length            :
                                                              null;

            if (typeof src === 'string' && fs.existsSync(src))
              await sftp.fastPut(src, rFile, {concurrency:1});
            else
              await sftp.put(src, rFile, {concurrency:1, rejectOnError:true});

            const st = await sftp.stat(rFile).catch(()=>({size:-1}));
            if (exp !== null && st.size !== exp)
              throw new Error(`size mismatch: expected ${exp}, got ${st.size}`);

            msg.payload = {ok:true,path:path.posix.join(workdir,rFile),size:st.size};
            await sftp.cwd('..');
            break;
          }

          default:
            throw new Error(`Unknown operation "${node.operation}"`);
        }

        node.status({fill:'green',shape:'dot',text:'done'});
        send(msg);                          // success
      } catch (err) {
        node.status({fill:'red',shape:'ring',text:'error'});
        node.error(err, msg);
        done && done(err);
      } finally {
        /* auto-close if we opened only for this msg */
        if (!hadCache && node.operation !== 'open') {
          try { await sftp.end(); } catch (_) {}
        }
        if (!hadCache) node.status({});
      }
    }

    /* graceful redeploy */
    node.on('close', (removed, doneClose) => {
      node.cfg._busy.finally(async () => {
        const cli = node.cfg && node.cfg._client;
        if (cli) { try { await cli.end(); } catch (_) {} node.cfg._client = null; }
        doneClose();
      });
    });
  }

  RED.nodes.registerType(
    'sftp in',
    SFtpNode,
    { credentials: {username:{type:'text'}, password:{type:'password'}} }
  );
};
