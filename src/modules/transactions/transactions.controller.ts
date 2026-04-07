import { Controller, Post, Body, Get, Delete, Param } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from '../../common/dto/create-transaction.dto';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post()
  create(@Body() dto: CreateTransactionDto) {
    return this.transactionsService.create(dto);
  }

  @Get('user/:userId')
  findByUser(@Param('userId') userId: string) {
    return this.transactionsService.findByUser(userId);
  }

  @Delete(':id/user/:userId')
  async softDelete(@Param('id') id: string, @Param('userId') userId: string) {
    await this.transactionsService.softDelete(id, userId);
    return { deleted: true };
  }
}
