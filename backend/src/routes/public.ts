import express from 'express';
import logging from '../utils/logging';
import * as familyModel from '../models/families';
import * as consumptionModel from '../models/consumptions';
import * as placeStoreModel from '../models/placeStores';
import { uploadFile } from '../utils/file';
import seed from '../../database/seeders/families';

const router = express.Router({ mergeParams: true });

/**
 * Search of family by NIS number
 */
router.get('/families', async (req, res) => {
  try {
    const item = await familyModel.findByNis(req.query.nis as string, req.query.cityId as string, undefined, true);
    if (!item) return res.status(404).send('Not found');
    const balance = await consumptionModel.getFamilyDependentBalance(item);
    return res.send({ ...item.toJSON(), balance });
  } catch (error) {
    logging.error(error);
    return res.status(500).send(error.message);
  }
});

/**
 * Get list of place stores
 */
router.get('/place-stores', async (req, res) => {
  try {
    const list = await placeStoreModel.getAll(req.query.cityId as string);
    res.send(list);
  } catch (error) {
    logging.error(error);
    res.status(500).send(error.message);
  }
});

/**
 * Search of family by NIS number
 */
router.post('/consumptions', async (req, res) => {
  try {
    const item = await consumptionModel.addConsumption({ ...req.body });
    return res.send(item);
  } catch (error) {
    logging.error(error);
    return res.status(error.status || 500).send(error.message);
  }
});

export default router;
