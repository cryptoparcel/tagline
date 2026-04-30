import { getSupabaseAdmin } from '../lib/supabase.js';
import { sendEmail } from '../lib/email.js';
import { escapeHtml } from '../lib/html.js';
import {
  requireMethod, getBody, ok, badRequest, serverError,
  isEmail, isString, rateLimit, getClientId
} from '../lib/util.js';

export const config = {
  api: {
    bodyParser: { sizeLimit: '8kb' }
  }
};

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  // Rate limit: 3 contact submissions per IP per 5 min
  const clientId = getClientId(req);
  if (!rateLimit(`contact:${clientId}`, { windowMs: 5 * 60_000, max: 3 })) {
    return badRequest(res, 'Too many messages. Try again in a few minutes.');
  }

  const body = getBody(req);
  const name = (body.name || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const subject = (body.subject || '').trim();
  const message = (body.message || '').trim();

  if (!isString(name, { min: 1, max: 100 })) {
    return badRequest(res, 'Please enter your name.');
  }
  // Reject control characters and angle brackets in name (header injection / XSS guard)
  if (/[\r\n\t\x00-\x1f\x7f<>]/.test(name)) {
    return badRequest(res, 'Name contains invalid characters.');
  }
  if (!isEmail(email)) {
    return badRequest(res, 'Please enter a valid email address.');
  }
  if (!isString(message, { min: 10, max: 5000 })) {
    return badRequest(res, 'Message must be between 10 and 5000 characters.');
  }
  if (subject && !isString(subject, { max: 200 })) {
    return badRequest(res, 'Subject is too long.');
  }
  if (subject && /[\r\n\t\x00-\x1f\x7f]/.test(subject)) {
    return badRequest(res, 'Subject contains invalid characters.');
  }

  try {
    const supabase = getSupabaseAdmin();

    const { error } = await supabase
      .from('contact_messages')
      .insert({ name, email, subject: subject || null, message });

    if (error) {
      console.error('Contact insert error:', error);
      return serverError(res, 'Could not send message. Please try again.');
    }

    // Email admin (best effort, doesn't block response)
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      // Sanitize for email subject:
      // - strip CR/LF (header injection)
      // - strip control chars
      // - strip any HTML/quotes
      // - cap length
      const safeName = sanitizeForSubject(name);
      const safeSubject = sanitizeForSubject(subject);

      sendEmail({
        to: adminEmail,
        replyTo: email,
        subject: `[TAGLINE] New message from ${safeName}${safeSubject ? ': ' + safeSubject : ''}`,
        html: `
          <p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
          ${subject ? `<p><strong>Subject:</strong> ${escapeHtml(subject)}</p>` : ''}
          <p><strong>Message:</strong></p>
          <p style="white-space:pre-wrap">${escapeHtml(message)}</p>
        `
      }).catch(err => console.error('Admin email failed:', err));
    }

    return ok(res, { message: 'Message received. We\'ll be in touch.' });
  } catch (err) {
    console.error('Contact handler error:', err);
    return serverError(res);
  }
}

// Strip line breaks, control characters, and any HTML to prevent
// email header injection and to keep subject lines safe.
function sanitizeForSubject(s) {
  return String(s || '')
    .replace(/[\r\n\t\v\f\x00-\x1f\x7f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

