import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../database/prisma.service';
import { CreateUserDto } from '../../common/dto/create-user.dto';
import { User, InvestmentHorizon } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  private strip(user: User) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash: _, ...safe } = user;
    return safe;
  }

  async findAll() {
    return (await this.prisma.user.findMany()).map((u) => this.strip(u));
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user ? this.strip(user) : null;
  }

  async create(dto: CreateUserDto) {
    const passwordHash = dto.password ? await bcrypt.hash(dto.password, 10) : null;
    return this.strip(
      await this.prisma.user.create({
        data: { email: dto.email, name: dto.name, passwordHash },
      }),
    );
  }

  async updatePreferences(id: string, preferences: { investmentHorizon?: InvestmentHorizon }) {
    const user = await this.prisma.user.update({
      where: { id },
      data: { investmentHorizon: preferences.investmentHorizon },
    });
    return this.strip(user);
  }
}
