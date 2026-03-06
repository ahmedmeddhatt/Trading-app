/**
 * Unit tests for AuthService.
 * Covers: register (hashing, conflict), login (valid/invalid credentials),
 * issueToken (payload shape — no passwordHash).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { PrismaService } from '../../database/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
    upsert: jest.fn(),
  },
};

const mockJwt = {
  sign: jest.fn().mockReturnValue('mock.jwt.token'),
};

const testUser = {
  id: 'user-uuid-1',
  email: 'test@example.com',
  name: 'Test User',
  passwordHash: '$2b$10$hashedpassword',
  googleId: null,
  appleId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwt },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  // ── register ──────────────────────────────────────────────────────────────

  describe('register', () => {
    it('hashes password before storing (never stores plaintext)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null); // email not taken
      mockPrisma.user.create.mockResolvedValue(testUser);

      await service.register({ email: 'new@example.com', name: 'New', password: 'password123' });

      const createCall = mockPrisma.user.create.mock.calls[0][0].data;
      expect(createCall.passwordHash).toBeDefined();
      expect(createCall.passwordHash).not.toBe('password123');
      // Verify it's a real bcrypt hash
      const valid = await bcrypt.compare('password123', createCall.passwordHash);
      expect(valid).toBe(true);
    });

    it('throws ConflictException when email already exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(testUser); // email already taken

      await expect(
        service.register({ email: 'test@example.com', name: 'Dup', password: 'password123' }),
      ).rejects.toThrow(ConflictException);
    });

    it('does not call user.create when email already exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(testUser);

      await service.register({ email: 'test@example.com', name: 'X', password: 'pass' }).catch(() => {});

      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('returns the created user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue(testUser);

      const result = await service.register({ email: 'new@example.com', name: 'New', password: 'password123' });
      expect(result.id).toBe(testUser.id);
      expect(result.email).toBe(testUser.email);
    });
  });

  // ── login ─────────────────────────────────────────────────────────────────

  describe('login', () => {
    it('returns user on valid credentials', async () => {
      const realHash = await bcrypt.hash('correctpass', 10);
      mockPrisma.user.findUnique.mockResolvedValue({ ...testUser, passwordHash: realHash });

      const result = await service.login({ email: 'test@example.com', password: 'correctpass' });
      expect(result.id).toBe(testUser.id);
    });

    it('throws UnauthorizedException on wrong password', async () => {
      const realHash = await bcrypt.hash('correctpass', 10);
      mockPrisma.user.findUnique.mockResolvedValue({ ...testUser, passwordHash: realHash });

      await expect(
        service.login({ email: 'test@example.com', password: 'wrongpass' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException on unknown email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nobody@example.com', password: 'any' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when user has no passwordHash (OAuth user)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...testUser, passwordHash: null });

      await expect(
        service.login({ email: 'oauth@example.com', password: 'any' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── issueToken ────────────────────────────────────────────────────────────

  describe('issueToken', () => {
    it('JWT payload contains sub (userId) and email', () => {
      service.issueToken(testUser);

      const signCall = mockJwt.sign.mock.calls[0][0];
      expect(signCall.sub).toBe(testUser.id);
      expect(signCall.email).toBe(testUser.email);
    });

    it('JWT payload does NOT contain passwordHash', () => {
      service.issueToken(testUser);

      const signCall = mockJwt.sign.mock.calls[0][0];
      expect(signCall).not.toHaveProperty('passwordHash');
    });

    it('returns the token string from jwt.sign', () => {
      const token = service.issueToken(testUser);
      expect(token).toBe('mock.jwt.token');
    });
  });
});
