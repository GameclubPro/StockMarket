import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';

const encoder = new TextEncoder();

export type SessionPayload = {
  sub: string;
  tid: string;
  username?: string;
};

const getSecret = () => {
  if (!config.appSecret) throw new Error('APP_SECRET is missing');
  return encoder.encode(config.appSecret);
};

export const signSession = async (payload: SessionPayload) => {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(getSecret());
};

export const verifySession = async (token: string) => {
  const { payload } = await jwtVerify<SessionPayload>(token, getSecret());
  return payload;
};
