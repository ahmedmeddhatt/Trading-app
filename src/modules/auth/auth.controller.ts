import {
  Controller,
  Post,
  Get,
  Body,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { AppleAuthGuard } from './guards/apple-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

const COOKIE_NAME = 'access_token';
const COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  private setAuthCookie(res: any, token: string): void {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: this.config.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      maxAge: COOKIE_TTL_MS,
    });
  }

  @Post('register')
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: any) {
    const user = await this.authService.register(dto);
    this.setAuthCookie(res, this.authService.issueToken(user));
    const { passwordHash, ...safe } = user;
    return safe;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: any) {
    const user = await this.authService.login(dto);
    this.setAuthCookie(res, this.authService.issueToken(user));
    const { passwordHash, ...safe } = user;
    return safe;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: any) {
    res.clearCookie(COOKIE_NAME);
    return { message: 'Logged out' };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: any) {
    return user;
  }

  // ── Google OAuth ──────────────────────────────────────────
  @Get('google')
  @UseGuards(GoogleAuthGuard)
  googleLogin() {
    // Passport redirects to Google
  }

  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  googleCallback(@CurrentUser() user: any, @Res() res: any) {
    this.setAuthCookie(res, this.authService.issueToken(user));
    return res.redirect(this.config.get<string>('FRONTEND_URL') ?? '/');
  }

  // ── Apple OAuth ───────────────────────────────────────────
  @Get('apple')
  @UseGuards(AppleAuthGuard)
  appleLogin() {
    // Passport redirects to Apple
  }

  @Post('apple/callback')
  @UseGuards(AppleAuthGuard)
  appleCallback(@CurrentUser() user: any, @Res() res: any) {
    this.setAuthCookie(res, this.authService.issueToken(user));
    return res.redirect(this.config.get<string>('FRONTEND_URL') ?? '/');
  }
}
