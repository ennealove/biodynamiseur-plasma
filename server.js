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

  const attributes = {
    PRENOM:           prenom  || '',
    NOM:              nom     || '',
    STAGE_SESSION:    sessionLabel || session,
    STAGE_MESSAGE:    message || '',
    SOURCE:           'Formulaire Dynamiseur Eau — Axis Lumen',
    DATE_INSCRIPTION: new Date().toISOString().split('T')[0]
  };
  if (phone) attributes.SMS = phone;

  try {
    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': BREVO_API_KEY
      },
      body: JSON.stringify({
        email,
        updateEnabled: true,
        listIds: [BREVO_LIST_ID],
        attributes
      })
    });

    if (response.ok || response.status === 204) {
      return res.json({ ok: true });
    }
    const body = await response.text();
    console.error('[Brevo] Erreur', response.status, body);
    return res.status(502).json({ error: 'Brevo error', status: response.status, detail: body });

  } catch (err) {
    console.error('[Brevo] Exception', err.message);
    return res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
