/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/libs', '<rootDir>/tests'],
  testMatch: ['**/*.spec.ts', '**/tests/**/*.test.ts'],
  modulePathIgnorePatterns: ['<rootDir>/.*/dist/'],
  clearMocks: true,
  moduleNameMapper: {
    '^@pulsegate/domain$': '<rootDir>/libs/domain/src/index.ts',
    '^@pulsegate/contracts$': '<rootDir>/libs/contracts/src/index.ts',
    '^@pulsegate/application$': '<rootDir>/libs/application/src/index.ts',
    '^@pulsegate/infrastructure$': '<rootDir>/libs/infrastructure/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2022',
          module: 'CommonJS',
          moduleResolution: 'Node',
          esModuleInterop: true,
          strict: true,
          types: ['node', 'jest'],
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      },
    ],
  },
};
