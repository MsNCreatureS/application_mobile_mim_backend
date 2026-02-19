const express = require('express');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get('/types', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT IdType, NomType, Famille
       FROM TypeEquipement
       ORDER BY Famille ASC, NomType ASC`
    );

    const famillesMap = new Map();

    rows.forEach((row) => {
      if (!famillesMap.has(row.Famille)) {
        famillesMap.set(row.Famille, []);
      }

      famillesMap.get(row.Famille).push({
        idType: row.IdType,
        nomType: row.NomType,
      });
    });

    const familles = Array.from(famillesMap.entries()).map(([famille, types]) => ({
      famille,
      types,
    }));

    return res.json({ success: true, familles });
  } catch (error) {
    console.error('Erreur GET /equipements/types:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.get('/check-numero/:numeroInterne', async (req, res) => {
  try {
    const numeroInterne = String(req.params.numeroInterne || '').trim();

    if (!numeroInterne) {
      return res.status(400).json({ success: false, message: 'NumeroInterne requis.' });
    }

    const [rows] = await pool.execute(
      'SELECT IdEquipement FROM Equipement WHERE NumeroInterne = ? LIMIT 1',
      [numeroInterne]
    );

    return res.json({
      success: true,
      exists: rows.length > 0,
    });
  } catch (error) {
    console.error('Erreur GET /equipements/check-numero:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      numeroInterne,
      idType,
      affectation = '',
      localisation = '',
      observations = '',
    } = req.body;

    const numeroNettoye = String(numeroInterne || '').trim();
    const idTypeInt = Number(idType);

    if (!numeroNettoye || !Number.isInteger(idTypeInt) || idTypeInt <= 0) {
      return res.status(400).json({
        success: false,
        message: 'numeroInterne et idType valides sont requis.',
      });
    }

    const [existingRows] = await pool.execute(
      'SELECT IdEquipement FROM Equipement WHERE NumeroInterne = ? LIMIT 1',
      [numeroNettoye]
    );

    if (existingRows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Ce numéro interne existe déjà.',
      });
    }

    const [typeRows] = await pool.execute(
      'SELECT IdType FROM TypeEquipement WHERE IdType = ? LIMIT 1',
      [idTypeInt]
    );

    if (typeRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Type équipement introuvable.',
      });
    }

    const [insertResult] = await pool.execute(
      `INSERT INTO Equipement (NumeroInterne, Affectation, Localisation, Observations, Status, IdType)
       VALUES (?, ?, ?, ?, 'ACTIF', ?)`,
      [numeroNettoye, affectation, localisation, observations, idTypeInt]
    );

    return res.status(201).json({
      success: true,
      message: 'Équipement ajouté avec succès.',
      equipement: {
        idEquipement: insertResult.insertId,
        numeroInterne: numeroNettoye,
        affectation,
        localisation,
        observations,
        status: 'ACTIF',
        idType: idTypeInt,
      },
    });
  } catch (error) {
    console.error('Erreur POST /equipements:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;
