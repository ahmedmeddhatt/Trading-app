import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../database/prisma.service';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { User } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  email: string;
}

export interface OAuthUserDto {
  provider: 'google' | 'apple';
  providerId: string;
  email: string;
  name?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<User> {
    const exists = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (exists) throw new ConflictException('Email already in use');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    return this.prisma.user.create({
      data: { email: dto.email, name: dto.name, passwordHash },
    });
  }

  async login(dto: LoginDto): Promise<User> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user || !user.passwordHash) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    return user;
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ resetToken: string }> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) throw new NotFoundException('No account with that email');

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await (this.prisma.user as any).update({
      where: { email: dto.email },
      data: { resetToken, resetTokenExpiry },
    });

    // In production, send via email. Returning token directly for dev/testing.
    return { resetToken };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const user = await (this.prisma.user as any).findFirst({
      where: { resetToken: dto.token },
    });

    if (!user) throw new BadRequestException('Invalid or expired reset token');
    if (new Date() > user.resetTokenExpiry) throw new BadRequestException('Reset token has expired');

    const passwordHash = await bcrypt.hash(dto.password, 10);

    await (this.prisma.user as any).update({
      where: { id: user.id },
      data: { passwordHash, resetToken: null, resetTokenExpiry: null },
    });

    return { message: 'Password reset successfully' };
  }

  async validateOAuthUser(dto: OAuthUserDto): Promise<User> {
    const idField = dto.provider === 'google' ? 'googleId' : 'appleId';

    return this.prisma.user.upsert({
      where: { [dto.provider === 'google' ? 'googleId' : 'appleId']: dto.providerId } as any,
      update: {},
      create: {
        email: dto.email,
        name: dto.name ?? dto.email.split('@')[0],
        [idField]: dto.providerId,
      },
    });
  }

  issueToken(user: User): string {
    const payload: JwtPayload = { sub: user.id, email: user.email };
    return this.jwt.sign(payload);
  }
}
