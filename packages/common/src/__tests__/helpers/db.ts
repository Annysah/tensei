export default {
    setup: jest.fn(() => Promise.resolve()),
    setResourceModels: jest.fn(() => []),
    establishDatabaseConnection: jest.fn(),
    findUserByEmail: jest.fn(() => Promise.resolve()),
    getAdministratorsCount: jest.fn(() => 0),
    create: jest.fn(),
    update: jest.fn(),
    findAll: jest.fn(() => Promise.resolve({})),
    findAllByIds: jest.fn(() => Promise.resolve({})),
    findAllBelongingToMany: jest.fn(() => Promise.resolve({})),
    findOneById: jest.fn(),
    findOneByField: jest.fn(),
    findOneByFieldExcludingOne: jest.fn(),
    updateManyByIds: jest.fn(),
    deleteById: jest.fn(),
    updateManyWhere: jest.fn(),
    getAdministratorById: jest.fn()
}
