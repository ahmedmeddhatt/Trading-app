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
      clientID: config.get<string>('APPLE_CLIENT_ID'),
      teamID: config.get<string>('APPLE_TEAM_ID'),
      keyID: config.get<string>('APPLE_KEY_ID'),
      privateKeyLocation: config.get<string>('APPLE_PRIVATE_KEY_PATH'),
      callbackURL: config.get<string>('APPLE_CALLBACK_URL'),
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
