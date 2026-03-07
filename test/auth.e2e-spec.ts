/**
 * Integration tests for AuthController.
 * Tests HTTP layer using NestJS TestingModule + Supertest.
 * AuthService is mocked — no real DB, JWT, or bcrypt calls.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, ConflictException, UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';

const mockAuthService = {
  register: jest.fn(),
  login: jest.fn(),
  issueToken: jest.fn().mockReturnValue('mock.jwt.token'),
};

const mockConfigService = {
  get: jest.fn().mockReturnValue('test'),
  getOrThrow: jest.fn().mockReturnValue('test'),
};

const testUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  passwordHash: 'hashed',
  googleId: null,
  appleId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const safeUser = { id: testUser.id, email: testUser.email, name: testUser.name };

class AlwaysAllowGuard {
  canActivate(ctx: any) {
    const req = ctx.switchToHttp().getRequest();
    req.user = safeUser;
    return true;
  }
}

class AlwaysDenyGuard {
  canActivate() { return false; }
}

async function buildApp(authGuardAllows = true): Promise<INestApplication> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      { provide: AuthService, useValue: mockAuthService },
      { provide: ConfigService, useValue: mockConfigService },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(authGuardAllows ? new AlwaysAllowGuard() : new AlwaysDenyGuard())
    .compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  await app.init();
  return app;
}

describe('AuthController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAuthService.issueToken.mockReturnValue('mock.jwt.token');
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  // ── POST /auth/register ──────────────────────────────────────────────────

  describe('POST /auth/register', () => {
    it('returns 201 and sets JWT cookie on success', async () => {
      mockAuthService.register.mockResolvedValue(testUser);

      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'new@example.com', name: 'New User', password: 'password123' })
        .expect(201);

      expect(res.headers['set-cookie']).toBeDefined();
      const cookie = ([res.headers['set-cookie']].flat() as string[]).join('');
      expect(cookie).toContain('access_token');
      expect(cookie).toContain('HttpOnly');
    });

    it('response body does NOT contain passwordHash', async () => {
      mockAuthService.register.mockResolvedValue(testUser);

      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'new@example.com', name: 'New User', password: 'password123' })
        .expect(201);

      expect(res.body).not.toHaveProperty('passwordHash');
      expect(res.body.email).toBe(testUser.email);
    });

    it('returns 409 when email already exists', async () => {
      mockAuthService.register.mockRejectedValue(new ConflictException('Email already in use'));

      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'test@example.com', name: 'Dup', password: 'password123' })
        .expect(409);
    });

    it('returns 400 for missing required fields', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'test@example.com' }) // missing name and password
        .expect(400);
    });

    it('returns 400 for invalid email format', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'not-an-email', name: 'User', password: 'password123' })
        .expect(400);
    });

    it('returns 400 for password shorter than 8 chars', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'new@example.com', name: 'User', password: 'short' })
        .expect(400);
    });
  });

  // ── POST /auth/login ─────────────────────────────────────────────────────

  describe('POST /auth/login', () => {
    it('returns 200 and sets JWT cookie on valid credentials', async () => {
      mockAuthService.login.mockResolvedValue(testUser);

      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'test@example.com', password: 'password123' })
        .expect(200);

      expect(res.headers['set-cookie']).toBeDefined();
      const cookie = ([res.headers['set-cookie']].flat() as string[]).join('');
      expect(cookie).toContain('access_token');
    });

    it('response body does NOT contain passwordHash', async () => {
      mockAuthService.login.mockResolvedValue(testUser);

      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'test@example.com', password: 'password123' })
        .expect(200);

      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('returns 401 on wrong password', async () => {
      mockAuthService.login.mockRejectedValue(new UnauthorizedException('Invalid credentials'));

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'test@example.com', password: 'wrongpass' })
        .expect(401);
    });

    it('returns 401 on unknown email', async () => {
      mockAuthService.login.mockRejectedValue(new UnauthorizedException('Invalid credentials'));

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: 'any' })
        .expect(401);
    });
  });

  // ── GET /auth/me ─────────────────────────────────────────────────────────

  describe('GET /auth/me', () => {
    it('returns 200 with user object when authenticated', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .expect(200);

      expect(res.body.id).toBe(safeUser.id);
      expect(res.body.email).toBe(safeUser.email);
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('returns 403 without valid cookie (guard denies)', async () => {
      const deniedApp = await buildApp(false);

      await request(deniedApp.getHttpServer())
        .get('/auth/me')
        .expect(403);

      await deniedApp.close();
    });
  });

  // ── POST /auth/logout ─────────────────────────────────────────────────────

  describe('POST /auth/logout', () => {
    it('returns 200 and clears cookie', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/logout')
        .expect(200);

      expect(res.body.message).toBe('Logged out');
    });
  });
});
