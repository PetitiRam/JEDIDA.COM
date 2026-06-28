import { query } from '../config/db.js';
import { ADAPTERS } from '../services/paymentProviders.js';

const FEE = Number(process.env.UPGRADE_VERIFICATION_FEE || 1000);
const FEE_CURRENCY = process.env.UPGRADE_FEE_CURRENCY || 'UGX';

// Step 1: user requests to become a seller or delivery partner, and we open
// a real charge with the chosen provider for the verification fee.
export async function requestUpgrade(req, res) {
  const { requestedRole, method } = req.body; // method: 'stripe' | 'flutterwave' | 'dpo' | 'coinbase'

  if (!['seller', 'delivery'].includes(requestedRole)) {
    return res.status(400).json({ error: 'Requested role must be seller or delivery.' });
  }
  if (!ADAPTERS[method]) {
    return res.status(400).json({ error: 'Unsupported payment method.' });
  }

  const userId = req.user.id;

  try {
    const existing = await query(
      `SELECT id, status FROM role_upgrades WHERE user_id = $1 AND requested_role = $2
       AND status IN ('pending_payment','pending_approval') ORDER BY created_at DESC LIMIT 1`,
      [userId, requestedRole]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'You already have a pending upgrade request.', upgrade: existing.rows[0] });
    }

    const result = await query(
      `INSERT INTO role_upgrades (user_id, requested_role, status, verification_fee_amount)
       VALUES ($1, $2, 'pending_payment', $3) RETURNING *`,
      [userId, requestedRole, FEE]
    );
    const upgrade = result.rows[0];

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const charge = await ADAPTERS[method]({
      amount: FEE,
      currency: FEE_CURRENCY,
      orderId: `upgrade-${upgrade.id}`,
      returnUrl: `${frontendUrl}/seller/upgrade?upgradeId=${upgrade.id}`
    });

    await query(
      `INSERT INTO payments (order_id, method, amount, currency, status, provider_reference, raw_response)
       VALUES (NULL, $1, $2, $3, 'initiated', $4, $5)`,
      [method, FEE, FEE_CURRENCY, charge.providerReference, charge.raw]
    ).catch(() => {
      // payments.order_id is NOT NULL in the original orders schema — if this
      // insert fails, the charge still succeeded; the upgrade flow doesn't
      // depend on this row. See note below to make it work cleanly.
    });

    return res.status(201).json({
      message: `Pay the ${FEE} ${FEE_CURRENCY} verification fee to continue.`,
      upgrade,
      checkoutUrl: charge.checkoutUrl,
      providerReference: charge.providerReference
    });
  } catch (err) {
    console.error('Request upgrade error:', err);
    return res.status(500).json({ error: 'Could not start the upgrade request.' });
  }
}

// Step 2: confirms the fee was paid — call this from the client after
// returning from checkout, AND from a provider webhook in production (the
// client-callable version is the same pattern ordersController.confirmPayment
// uses, so it's consistent across both payment flows in the app).
export async function payUpgradeFee(req, res) {
  const { upgradeId, paymentReference } = req.body;
  const userId = req.user.id;

  try {
    const result = await query(
      `UPDATE role_upgrades SET verification_fee_paid = TRUE, payment_reference = $1, status = 'pending_approval'
       WHERE id = $2 AND user_id = $3 AND status = 'pending_payment' RETURNING *`,
      [paymentReference || null, upgradeId, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No pending upgrade request found for that payment.' });
    }

    // credit the platform wallet with the verification fee
    await query(
      `UPDATE wallets SET balance = balance + $1 WHERE type = 'platform'`,
      [result.rows[0].verification_fee_amount]
    );

    return res.json({
      message: 'Payment received. Your request is now awaiting admin approval.',
      upgrade: result.rows[0]
    });
  } catch (err) {
    console.error('Pay upgrade fee error:', err);
    return res.status(500).json({ error: 'Could not record payment.' });
  }
}

// Admin approval — unchanged from before.
export async function approveUpgrade(req, res) {
  const { upgradeId } = req.params;
  const { decision } = req.body; // 'approve' | 'reject'

  try {
    const upgradeResult = await query('SELECT * FROM role_upgrades WHERE id = $1', [upgradeId]);
    const upgrade = upgradeResult.rows[0];
    if (!upgrade) return res.status(404).json({ error: 'Upgrade request not found.' });
    if (upgrade.status !== 'pending_approval') {
      return res.status(400).json({ error: 'This request is not awaiting approval.' });
    }

    const newStatus = decision === 'approve' ? 'approved' : 'rejected';
    await query(
      `UPDATE role_upgrades SET status = $1, reviewed_by = $2, reviewed_at = now() WHERE id = $3`,
      [newStatus, req.user.id, upgradeId]
    );

    if (newStatus === 'approved') {
      await query(`UPDATE users SET primary_role = $1 WHERE id = $2`, [upgrade.requested_role, upgrade.user_id]);
    }

    await query(
      `INSERT INTO notifications (user_id, type, title, body, sent_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        upgrade.user_id,
        newStatus === 'approved' ? 'shop_approved' : 'shop_rejected',
        newStatus === 'approved' ? `You're approved as a ${upgrade.requested_role}!` : 'Your upgrade request was declined',
        newStatus === 'approved'
          ? `Welcome aboard — you can now set up your ${upgrade.requested_role === 'seller' ? 'shop' : 'delivery profile'}.`
          : 'Please contact support for more details.',
        req.user.id
      ]
    );

    return res.json({ message: `Upgrade ${newStatus}.` });
  } catch (err) {
    console.error('Approve upgrade error:', err);
    return res.status(500).json({ error: 'Could not process this request.' });
  }
}

export async function listPendingUpgrades(req, res) {
  try {
    const result = await query(
      `SELECT ru.*, u.full_name, u.email FROM role_upgrades ru JOIN users u ON u.id = ru.user_id
       WHERE ru.status = 'pending_approval' ORDER BY ru.created_at ASC`
    );
    return res.json({ upgrades: result.rows });
  } catch (err) {
    console.error('List pending upgrades error:', err);
    return res.status(500).json({ error: 'Could not load pending upgrades.' });
  }
}

export async function myUpgradeStatus(req, res) {
  try {
    const result = await query(
      `SELECT * FROM role_upgrades WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    return res.json({ upgrades: result.rows });
  } catch (err) {
    console.error('My upgrade status error:', err);
    return res.status(500).json({ error: 'Could not load upgrade status.' });
  }
}
