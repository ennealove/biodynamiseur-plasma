const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

const BREVO_API_KEY          = process.env.BREVO_API_KEY;
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET;
const BREVO_LIST_ID = 6;

// ─── Webhook Stripe — corps brut obligatoire pour vérifier la signature ───────
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig       = req.headers['stripe-signature'];
  const payload   = req.body;

  // Vérification signature Stripe
  if (STRIPE_WEBHOOK_SECRET) {
    try {
      const parts    = sig.split(',').reduce((acc, p) => { const [k,v] = p.split('='); acc[k]=v; return acc; }, {});
      const toSign   = `${parts.t}.${payload}`;
      const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(toSign, 'utf8').digest('hex');
      if (expected !== parts.v1) {
        console.warn('[Stripe] Signature invalide');
        return res.status(400).json({ error: 'Signature invalide' });
      }
    } catch (e) {
      return res.status(400).json({ error: 'Erreur vérification signature' });
    }
  }

  let event;
  try { event = JSON.parse(payload); } catch { return res.status(400).json({ error: 'JSON invalide' }); }

  if (event.type === 'checkout.session.completed') {
    const s          = event.data.object;
    const customerEmail = s.customer_details?.email || s.customer_email || 'inconnu';
    const customerName  = s.customer_details?.name  || '';
    const amount        = s.amount_total ? (s.amount_total / 100).toFixed(2) + ' €' : '—';
    const sessionId     = s.id;

    console.log(`[Stripe] Paiement reçu — ${customerEmail} — ${amount}`);

    fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: 'Axis Lumen — Paiement', email: 'axislumen@outlook.fr' },
        to: [{ email: 'chauvetmichael@live.fr', name: 'Michael Chauvet' }],
        subject: `&#x1F4B3; Paiement re&#xe7;u — ${customerName || customerEmail}`,
        htmlContent: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden">
            <div style="background:#0D3B4A;padding:20px 24px">
              <h2 style="color:#2ecc71;margin:0;font-size:16px;letter-spacing:.04em">&#x2705; PAIEMENT RE&#xc7;U &#x2014; AXIS LUMEN</h2>
            </div>
            <div style="padding:24px">
              <table style="width:100%;border-collapse:collapse;font-size:14px">
                <tr><td style="padding:8px 0;color:#666;width:130px">Client</td><td style="padding:8px 0;font-weight:bold;color:#0D3B4A">${customerName || '&#x2014;'}</td></tr>
                <tr><td style="padding:8px 0;color:#666">Email</td><td style="padding:8px 0"><a href="mailto:${customerEmail}">${customerEmail}</a></td></tr>
                <tr><td style="padding:8px 0;color:#666">Montant</td><td style="padding:8px 0;font-weight:bold;color:#2e9e78">${amount}</td></tr>
                <tr><td style="padding:8px 0;color:#666">ID Stripe</td><td style="padding:8px 0;font-size:11px;color:#999">${sessionId}</td></tr>
                <tr><td style="padding:8px 0;color:#666">Date</td><td style="padding:8px 0">${new Date().toLocaleDateString('fr-FR', {day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})}</td></tr>
              </table>
            </div>
            <div style="background:#f0fff4;padding:12px 24px;font-size:12px;color:#2e9e78;font-weight:bold">
              Place r&#xe9;serv&#xe9;e &#x2014; contacter le participant dans les 48h
            </div>
          </div>
        </body></html>`
      })
    }).catch(err => console.warn('[Brevo] Erreur email paiement:', err.message));
  }

  res.json({ received: true });
});

// ─── Routes API classiques ────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

function toInternationalPhone(tel) {
  if (!tel) return '';
  const digits = tel.replace(/[\s.\-()]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('0')) return '+33' + digits.slice(1);
  return digits;
}

app.post('/api/add-contact', async (req, res) => {
  const { email, prenom, nom, tel, session, sessionLabel, message } = req.body;

  if (!email || !session) {
    return res.status(400).json({ error: 'email et session requis' });
  }

  const phone = toInternationalPhone(tel);

  const buildAttributes = (withPhone) => {
    const attrs = {
      PRENOM:           prenom  || '',
      NOM:              nom     || '',
      STAGE_SESSION:    sessionLabel || session,
      STAGE_MESSAGE:    message || '',
      SOURCE:           'Formulaire Dynamiseur Eau — Axis Lumen',
      DATE_INSCRIPTION: new Date().toISOString().split('T')[0]
    };
    if (withPhone && phone) attrs.SMS = phone;
    return attrs;
  };

  const callBrevo = (attributes) => fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
    body: JSON.stringify({ email, updateEnabled: true, listIds: [BREVO_LIST_ID], attributes })
  });

  try {
    let response = await callBrevo(buildAttributes(true));

    // Si SMS déjà associé à un autre contact, réessayer sans SMS
    if (!response.ok) {
      const txt = await response.text();
      if (txt.includes('duplicate_parameter') && txt.includes('SMS')) {
        console.warn('[Brevo] SMS en doublon, retry sans SMS');
        response = await callBrevo(buildAttributes(false));
      } else {
        console.error('[Brevo] Erreur', response.status, txt);
        return res.status(502).json({ error: 'Brevo error', status: response.status, detail: txt });
      }
    }

    if (response.ok || response.status === 204) {
      // Email de confirmation au CLIENT
      fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
        body: JSON.stringify({
          sender: { name: 'Michael — Axis Lumen', email: 'axislumen@outlook.fr' },
          to: [{ email, name: `${prenom || ''} ${nom || ''}`.trim() || email }],
          subject: `Votre inscription au stage Axis Lumen — ${sessionLabel || session}`,
          htmlContent: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden">
              <div style="background:#0D3B4A;padding:24px">
                <h2 style="color:#7EC8D3;margin:0;font-size:17px">Axis Lumen &#x2014; Stage Eau Vivante Plasma</h2>
              </div>
              <div style="padding:28px;font-size:15px;color:#1A2B35;line-height:1.8">
                <p>Bonjour <strong>${prenom || ''}</strong>,</p>
                <p style="margin-top:12px">Merci pour votre int&#xe9;r&#xea;t pour le stage <strong>${sessionLabel || session}</strong>. Votre demande d&#x27;inscription a bien &#xe9;t&#xe9; re&#xe7;ue.</p>
                <div style="background:#f0f8ff;border-left:3px solid #1e8bc3;padding:14px 18px;margin:20px 0;border-radius:0 6px 6px 0">
                  <p style="margin:0;font-weight:bold;color:#0D3B4A">Session : ${sessionLabel || session}</p>
                  <p style="margin:6px 0 0;font-size:13px;color:#5a7a85">Lieu : Le Mas d&#x27;Elzas, Saint-Gilles-du-Gard (30)</p>
                </div>
                <p>Je vous contacterai personnellement dans les <strong>48h</strong> pour confirmer votre place et vous transmettre toutes les informations pratiques (lieu exact, h&#xe9;bergement, mat&#xe9;riel &#xe0; pr&#xe9;voir).</p>
                <p style="margin-top:16px">Si vous n&#x27;avez pas encore finalis&#xe9; votre r&#xe9;servation, vous pouvez proc&#xe9;der au paiement s&#xe9;curis&#xe9; via le lien qui vous a &#xe9;t&#xe9; pr&#xe9;sent&#xe9; sur le site.</p>
                <p style="margin-top:20px">&#xe0; tr&#xe8;s bient&#xf4;t,<br><strong>Michael Chauvet</strong><br>Fondateur Axis Lumen</p>
              </div>
              <div style="background:#f5f5f5;padding:14px 28px;font-size:12px;color:#999">
                Questions ? <a href="mailto:chauvetmichael@live.fr" style="color:#1e8bc3">chauvetmichael@live.fr</a> &nbsp;&#xb7;&nbsp; 06 56 53 33 17
              </div>
            </div>
          </body></html>`
        })
      }).catch(err => console.warn('[Brevo] Erreur email client inscription:', err.message));

      // Notification email à Michael
      fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
        body: JSON.stringify({
          sender: { name: 'Axis Lumen — Stage', email: 'axislumen@outlook.fr' },
          to: [{ email: 'chauvetmichael@live.fr', name: 'Michael Chauvet' }],
          subject: `Nouvelle inscription stage — ${sessionLabel || session}`,
          htmlContent: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden">
              <div style="background:#0D3B4A;padding:20px 24px">
                <h2 style="color:#7EC8D3;margin:0;font-size:16px;letter-spacing:.04em">AXIS LUMEN &#x2014; NOUVELLE INSCRIPTION</h2>
              </div>
              <div style="padding:24px">
                <table style="width:100%;border-collapse:collapse;font-size:14px">
                  <tr><td style="padding:8px 0;color:#666;width:130px">Session</td><td style="padding:8px 0;font-weight:bold;color:#0D3B4A">${sessionLabel || session}</td></tr>
                  <tr><td style="padding:8px 0;color:#666">Pr&#xe9;nom</td><td style="padding:8px 0">${prenom || '&#x2014;'}</td></tr>
                  <tr><td style="padding:8px 0;color:#666">Nom</td><td style="padding:8px 0">${nom || '&#x2014;'}</td></tr>
                  <tr><td style="padding:8px 0;color:#666">Email</td><td style="padding:8px 0"><a href="mailto:${email}">${email}</a></td></tr>
                  <tr><td style="padding:8px 0;color:#666">T&#xe9;l&#xe9;phone</td><td style="padding:8px 0">${phone || '&#x2014;'}</td></tr>
                  <tr><td style="padding:8px 0;color:#666;vertical-align:top">Message</td><td style="padding:8px 0;line-height:1.6">${message || '&#x2014;'}</td></tr>
                  <tr><td style="padding:8px 0;color:#666">Date</td><td style="padding:8px 0">${new Date().toLocaleDateString('fr-FR', {day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})}</td></tr>
                </table>
              </div>
              <div style="background:#f5f5f5;padding:12px 24px;font-size:12px;color:#999">
                Contact ajout&#xe9; &#xe0; la liste Brevo &#x2014; Stages Axis Lumen
              </div>
            </div>
          </body></html>`
        })
      }).catch(err => console.warn('[Brevo email] Erreur notification:', err.message));

      return res.json({ ok: true });
    }
    const errBody = await response.text();
    console.error('[Brevo] Erreur finale', response.status, errBody);
    return res.status(502).json({ error: 'Brevo error', status: response.status, detail: errBody });

  } catch (err) {
    console.error('[Brevo] Exception', err.message);
    return res.status(502).json({ error: err.message });
  }
});

// ─── Formulaire de contact simple ────────────────────────────────────────────
app.post('/api/contact', async (req, res) => {
  const { prenom, nom, email, tel, message } = req.body;
  if (!email || !message) return res.status(400).json({ error: 'email et message requis' });

  const displayName = `${prenom || ''} ${nom || ''}`.trim() || email;

  // Email à Michael
  const toMichael = fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: 'Axis Lumen — Contact', email: 'axislumen@outlook.fr' },
      to: [{ email: 'chauvetmichael@live.fr', name: 'Michael Chauvet' }],
      subject: `&#x2709; Nouveau message — ${displayName}`,
      htmlContent: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden">
          <div style="background:#0D3B4A;padding:20px 24px">
            <h2 style="color:#7EC8D3;margin:0;font-size:16px">&#x2709; NOUVEAU MESSAGE &#x2014; AXIS LUMEN</h2>
          </div>
          <div style="padding:24px">
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr><td style="padding:8px 0;color:#666;width:110px">Pr&#xe9;nom</td><td style="padding:8px 0">${prenom || '&#x2014;'}</td></tr>
              <tr><td style="padding:8px 0;color:#666">Nom</td><td style="padding:8px 0">${nom || '&#x2014;'}</td></tr>
              <tr><td style="padding:8px 0;color:#666">Email</td><td style="padding:8px 0"><a href="mailto:${email}">${email}</a></td></tr>
              <tr><td style="padding:8px 0;color:#666">T&#xe9;l&#xe9;phone</td><td style="padding:8px 0">${tel || '&#x2014;'}</td></tr>
              <tr><td style="padding:8px 0;color:#666;vertical-align:top">Message</td><td style="padding:8px 0;line-height:1.7">${message}</td></tr>
              <tr><td style="padding:8px 0;color:#666">Date</td><td style="padding:8px 0">${new Date().toLocaleDateString('fr-FR', {day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})}</td></tr>
            </table>
          </div>
          <div style="background:#fff8e1;padding:12px 24px;font-size:12px;color:#8a6000">
            R&#xe9;pondre directement &#xe0; cet email pour contacter ${displayName}
          </div>
        </div>
      </body></html>`
    })
  });

  // Email de confirmation au visiteur
  const toClient = fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: 'Michael — Axis Lumen', email: 'axislumen@outlook.fr' },
      to: [{ email, name: displayName }],
      subject: 'Votre message a bien &#xe9;t&#xe9; re&#xe7;u — Axis Lumen',
      htmlContent: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden">
          <div style="background:#0D3B4A;padding:24px">
            <h2 style="color:#7EC8D3;margin:0;font-size:17px">Axis Lumen &#x2014; Message re&#xe7;u</h2>
          </div>
          <div style="padding:28px;font-size:15px;color:#1A2B35;line-height:1.8">
            <p>Bonjour <strong>${prenom || ''}</strong>,</p>
            <p style="margin-top:12px">Merci pour votre message. Je l&#x27;ai bien re&#xe7;u et vous r&#xe9;pondrai personnellement sous <strong>48h</strong>.</p>
            <div style="background:#f0f8ff;border-left:3px solid #1e8bc3;padding:14px 18px;margin:20px 0;border-radius:0 6px 6px 0;font-size:13px;color:#2e5f7a;line-height:1.7">
              <em>&#x201C;${message.length > 180 ? message.substring(0, 180) + '&#x2026;' : message}&#x201D;</em>
            </div>
            <p>En attendant, vous pouvez explorer le site pour en savoir plus sur le protocole Eau Vivante Plasma et les stages Axis Lumen.</p>
            <p style="margin-top:20px">&#xe0; tr&#xe8;s bient&#xf4;t,<br><strong>Michael Chauvet</strong><br>Fondateur Axis Lumen</p>
          </div>
          <div style="background:#f5f5f5;padding:14px 28px;font-size:12px;color:#999">
            <a href="mailto:chauvetmichael@live.fr" style="color:#1e8bc3">chauvetmichael@live.fr</a> &nbsp;&#xb7;&nbsp; 06 56 53 33 17
          </div>
        </div>
      </body></html>`
    })
  });

  try {
    await Promise.all([toMichael, toClient]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Contact] Erreur:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
