const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_LIST_ID = 6;

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
      // Notification email à Michael
      fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
        body: JSON.stringify({
          sender: { name: 'Axis Lumen — Stage', email: 'axislumen@outlook.fr' },
          to: [{ email: 'chauvetmichael@live.fr', name: 'Michael Chauvet' }],
          subject: `Nouvelle inscription stage — ${sessionLabel || session}`,
          htmlContent: `
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden">
              <div style="background:#0D3B4A;padding:20px 24px">
                <h2 style="color:#7EC8D3;margin:0;font-size:16px;letter-spacing:.04em">AXIS LUMEN — NOUVELLE INSCRIPTION</h2>
              </div>
              <div style="padding:24px">
                <table style="width:100%;border-collapse:collapse;font-size:14px">
                  <tr><td style="padding:8px 0;color:#666;width:130px">Session</td><td style="padding:8px 0;font-weight:bold;color:#0D3B4A">${sessionLabel || session}</td></tr>
                  <tr><td style="padding:8px 0;color:#666">Prénom</td><td style="padding:8px 0">${prenom || '—'}</td></tr>
                  <tr><td style="padding:8px 0;color:#666">Nom</td><td style="padding:8px 0">${nom || '—'}</td></tr>
                  <tr><td style="padding:8px 0;color:#666">Email</td><td style="padding:8px 0"><a href="mailto:${email}">${email}</a></td></tr>
                  <tr><td style="padding:8px 0;color:#666">Téléphone</td><td style="padding:8px 0">${tel || '—'}</td></tr>
                  <tr><td style="padding:8px 0;color:#666;vertical-align:top">Message</td><td style="padding:8px 0;line-height:1.6">${message || '—'}</td></tr>
                  <tr><td style="padding:8px 0;color:#666">Date</td><td style="padding:8px 0">${new Date().toLocaleDateString('fr-FR', {day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})}</td></tr>
                </table>
              </div>
              <div style="background:#f5f5f5;padding:12px 24px;font-size:12px;color:#999">
                Contact ajouté à la liste Brevo — Stages Axis Lumen
              </div>
            </div>
          `
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

app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
