import db from '../../src/schemas';
import { Family } from '../../src/schemas/families';
import benefits from './benefits';
import moment from 'moment';
import faker from 'faker/locale/pt_BR';

const FAMILIES_COUNT = 10;

const benefitsGroupList = benefits.groupList;

const list = [
  {
    code: '1234',
    groupName: 'cad',
    responsibleName: 'JOÃO FERNANDO BARAKY',
    responsibleBirthday: moment('20/12/1991', 'DD/MM/YYYY').toDate(),
    responsibleNis: '1234',
    responsibleMotherName: 'HILDA LÚCIA BARAKY'
  },
  {
    code: '10000000',
    groupName: 'extreme-poverty',
    responsibleName: 'JOSÉ ALMEIDA DA SILVA',
    responsibleBirthday: moment('01/01/1988', 'DD/MM/YYYY').toDate(),
    responsibleNis: '10000000000',
    responsibleMotherName: 'MARIA RITA DA SILVA'
  },
  {
    code: '20000000',
    groupName: 'poverty-line',
    responsibleName: 'MARIA ARAÚJO',
    responsibleBirthday: moment('06/07/1979', 'DD/MM/YYYY').toDate(),
    responsibleNis: '20000000000',
    responsibleMotherName: 'MARIA RITA DA SILVA'
  },
  {
    code: '30000000',
    groupName: 'cad',
    responsibleName: 'TEREZA DE JESUS',
    responsibleBirthday: moment('01/10/1978', 'DD/MM/YYYY').toDate(),
    responsibleNis: '30000000000',
    responsibleMotherName: 'MARIA RITA DA SILVA'
  }
];

/**
 * Seed the place stores table
 */
const seed = async () => {
  const alreadyCreated = await db.families.findAll();

  if (alreadyCreated.length < FAMILIES_COUNT) {
    const cities = await db.cities.findAll();

    // First create prefefined families on the list
    const itemsToCreate = list
      .map((item) => {
        const created = alreadyCreated.find((dbItem) => dbItem.code === item.code);
        if (created) return null; // Item is already created, don't create it again
        return { ...item, cityId: cities[0].id };
      })
      .filter(Boolean) as Family[];

    // Then generate the remaning families
    const alreadyCreatedCount = alreadyCreated.length + itemsToCreate.length;
    itemsToCreate.push(
      ...(Array(FAMILIES_COUNT - alreadyCreatedCount)
        .fill({})
        .map((_, index) => ({
          code: String(alreadyCreatedCount + index).padEnd(8, '0'),
          groupName: benefitsGroupList[Math.floor(Math.random() * benefitsGroupList.length)].groupName,
          responsibleName: `${faker.name.firstName()} ${faker.name.lastName()} ${faker.name.lastName()}`.toLocaleUpperCase(),
          responsibleBirthday: faker.date.between('1960-01-01', '1991-12-31'),
          responsibleNis: String(alreadyCreatedCount + index).padEnd(11, '0'),
          responsibleMotherName: `${faker.name.firstName()} ${faker.name.lastName()} ${faker.name.lastName()}`.toLocaleUpperCase(),
          cityId: cities[0].id
        })) as Family[])
    );
    if (itemsToCreate.length > 0) {
      await db.families.bulkCreate(itemsToCreate, { individualHooks: true });
    }
    console.log(`[seed] Families: Seeded successfully - ${itemsToCreate.length} new created`);
  } else {
    console.log(`[seed] Families: Nothing to seed`);
  }
};

export default { seed };
