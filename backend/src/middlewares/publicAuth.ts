import CryptoJS from 'crypto-js';
import { NextFunction, Request, Response } from 'express';
import logging from '../utils/logging';
import moment from 'moment';

type PublicAuth = {
  now: Date | string | number;
  token: string;
};

/**
 * Handling the public endpoints token
 * @param req - express req
 * @param res - express res
 * @param next - express next
 * @returns void
 */
export const requirePublicAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const code = req.headers['authorization'] as string;
    if (!code) {
      return res.status(401).send('Unauthorized');
    }
    const bytes = CryptoJS.AES.decrypt(code, process.env.AUTH_SECRET || 'some-secret');
    const decryptedData = JSON.parse(bytes.toString(CryptoJS.enc.Utf8)) as PublicAuth;

    // Validating data;
    const { now, token } = decryptedData;
    if (!now || !token) {
      console.log(Object.keys(decryptedData));
      logging.critical('Request on public route using invalid object', decryptedData);
      return res.status(401).send('Unauthorized');
    }

    // Check if token is too old
    const timeDiff = moment(now).diff(moment(), 'hours');
    if (timeDiff > 6) {
      logging.error('Request on public route took too long', decryptedData);
      return res.status(401).send('Unauthorized');
    }
    const secondTimeDiff = moment(now).diff(moment(), 'seconds');
    if (secondTimeDiff > 30) {
      logging.error('Request took more than 30 seconds', { decryptedData, serverNow: moment().toISOString() });
    }

    // Check if token match
    if (token !== process.env.AUTH_TOKEN) {
      logging.error('Request on public route with invalid token', decryptedData);
      return res.status(401).send('Unauthorized');
    }

    return next();
  } catch (error) {
    logging.error(error);
    return res.status(500).send(error.message);
  }
};
