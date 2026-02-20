import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    config: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      clientID: config.get<string>('GOOGLE_CLIENT_ID') || 'NOT_SET',
      clientSecret: config.get<string>('GOOGLE_CLIENT_SECRET') || 'NOT_SET',
      callbackURL: config.get<string>('GOOGLE_CALLBACK_URL') || 'http://localhost:3000/auth/google/callback',
      scope: ['email', 'profile'],
      passReqToCallback: false as const,
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ): Promise<void> {
    const user = await this.authService.validateOAuthUser({
      provider: 'google',
      providerId: profile.id,
      email: profile.emails?.[0]?.value,
      name: profile.displayName,
    });
    done(null, user);
  }
}
