import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AuthLayout from '../components/AuthLayout';
import client from '../api/client';
import { useEffect } from 'react';

export default function VerifyPhone() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await client.post('/auth/verify-phone', { code });
      navigate('/marketplace');
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid code. Please try again.');
    } finally {
      setLoading(false);
    }
  };
useEffect(() => {
  const sendOtp = async () => {
    try {
      await client.post('/auth/send-otp');
    } catch (err) {
      console.log('Failed to send OTP:', err);
    }
  };

  sendOtp();
}, []);

  return (
    <AuthLayout>
      <div className="eyebrow">One last step</div>
      <h1>Verify your phone number</h1>
      <p className="hint">We sent a 6-digit code by SMS. Enter it below to start buying.</p>

      {error && <div className="alert alert-error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="field-group">
          <label htmlFor="code">Verification code</label>
          <input id="code" inputMode="numeric" maxLength={6} placeholder="••••••" value={code} onChange={(e) => setCode(e.target.value)} required />
        </div>
        <button className="btn-primary" type="submit" disabled={loading}>
          {loading ? 'Verifying…' : 'Verify and continue'}
        </button>
      </form>
    </AuthLayout>
  );
}
