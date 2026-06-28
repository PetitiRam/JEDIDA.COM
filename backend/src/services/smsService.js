import twilio from "twilio";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export const sendOtpSms = async (phone, otp) => {
  return client.messages.create({
    body: `Your Jedida verification code is ${otp}`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: phone
  });
};
