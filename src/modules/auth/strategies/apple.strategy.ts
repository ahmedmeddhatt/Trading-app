import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import Strategy from 'passport-apple';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';

@Injectable()
export class AppleStrategy extends PassportStrategy(Strategy, 'apple') {
  constructor(
    config: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      clientID: config.get<string>('APPLE_CLIENT_ID') || 'NOT_SET',
      teamID: config.get<string>('APPLE_TEAM_ID') || 'NOT_SET',
      keyID: config.get<string>('APPLE_KEY_ID') || 'NOT_SET',
      privateKeyLocation: config.get<string>('APPLE_PRIVATE_KEY_PATH') || './secrets/AuthKey.p8',
      callbackURL: config.get<string>('APPLE_CALLBACK_URL') || 'http://localhost:3000/auth/apple/callback',
      passReqToCallback: false,
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    idToken: any,
    profile: any,
    done: (err: any, user: any) => void,
  ): Promise<void> {
    const user = await this.authService.validateOAuthUser({
      provider: 'apple',
      providerId: idToken.sub,
      email: idToken.email,
      name: profile?.name?.firstName
        ? `${profile.name.firstName} ${profile.name.lastName ?? ''}`.trim()
        : undefined,
    });
    done(null, user);
  }
}
