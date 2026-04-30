import { getSupabaseAdmin } from '../lib/supabase.js';
import {
  requireMethod, getBody, ok, unauthorized, badRequest, serverError, isAdmin
} from '../lib/util.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET', 'POST')) return;

  if (!isAdmin(req)) {
    return unauthorized(res, 'Admin access required.');
  }

  const supabase = getSupabaseAdmin();

  // GET: dashboard data
  if (req.method === 'GET') {
    try {
      const allowedViews = ['orders', 'subscribers', 'messages', 'stats'];
      const view = (req.query?.view || 'orders').toString();
      if (!allowedViews.includes(view)) {
        return badRequest(res, 'Unknown view');
      }

      if (view === 'orders') {
        const { data, error } = await supabase
          .from('orders')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200);
        if (error) throw error;
        return ok(res, { orders: data });
      }

      if (view === 'subscribers') {
        const { data, error } = await supabase
          .from('subscribers')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(500);
        if (error) throw error;
        return ok(res, { subscribers: data });
      }

      if (view === 'messages') {
        const { data, error } = await supabase
          .from('contact_messages')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200);
        if (error) throw error;
        return ok(res, { messages: data });
      }

      if (view === 'stats') {
        const [orders, subs, msgs] = await Promise.all([
          supabase.from('orders').select('total_cents, status', { count: 'exact' }).eq('status', 'paid'),
          supabase.from('subscribers').select('id', { count: 'exact', head: true }).eq('active', true),
          supabase.from('contact_messages').select('id', { count: 'exact', head: true }).eq('status', 'new')
        ]);

        const revenue = (orders.data || []).reduce((s, o) => s + (o.total_cents || 0), 0);

        return ok(res, {
          stats: {
            paid_orders: orders.count || 0,
            revenue_cents: revenue,
            active_subscribers: subs.count || 0,
            unread_messages: msgs.count || 0
          }
        });
      }

      return badRequest(res, 'Unknown view');
    } catch (err) {
      console.error('Admin GET error:', err);
      return serverError(res);
    }
  }

  // POST: update an order's status or add tracking
  if (req.method === 'POST') {
    try {
      const body = getBody(req);
      const { action, order_id, status, tracking_number, message_id, message_status } = body;

      // UUID v4 format check
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (action === 'update_order') {
        if (!order_id || typeof order_id !== 'string' || !uuidRegex.test(order_id)) {
          return badRequest(res, 'Invalid order_id');
        }
        const updates = { updated_at: new Date().toISOString() };
        if (status && ['pending','paid','shipped','delivered','cancelled','refunded'].includes(status)) {
          updates.status = status;
        }
        if (tracking_number) {
          // Common carrier formats are alphanumeric (UPS, FedEx, USPS, DHL).
          // Allow 8-40 chars of [A-Z0-9] (case-insensitive) to cover them all.
          if (typeof tracking_number !== 'string' || !/^[A-Z0-9]{8,40}$/i.test(tracking_number)) {
            return badRequest(res, 'Invalid tracking number');
          }
          updates.tracking_number = tracking_number.toUpperCase();
        }

        const { error } = await supabase.from('orders').update(updates).eq('id', order_id);
        if (error) throw error;
        return ok(res, { updated: true });
      }

      if (action === 'update_message') {
        if (!message_id || typeof message_id !== 'string' || !uuidRegex.test(message_id)) {
          return badRequest(res, 'Invalid message_id');
        }
        const valid = ['new', 'read', 'replied', 'archived'];
        if (!valid.includes(message_status)) return badRequest(res, 'invalid status');

        const { error } = await supabase
          .from('contact_messages')
          .update({ status: message_status })
          .eq('id', message_id);
        if (error) throw error;
        return ok(res, { updated: true });
      }

      return badRequest(res, 'Unknown action');
    } catch (err) {
      console.error('Admin POST error:', err);
      return serverError(res);
    }
  }
}
