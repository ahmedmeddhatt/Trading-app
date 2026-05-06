import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminEmailGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: { email?: string } }>();
    const email = req.user?.email?.toLowerCase().trim();
    if (!email) {
      throw new ForbiddenException('Authentication required');
    }

    const raw = this.config.get<string>('ADMIN_EMAILS') ?? '';
    const allowed = raw
      .split(',')
      .map((e) => e.toLowerCase().trim())
      .filter(Boolean);

    if (!allowed.includes(email)) {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
