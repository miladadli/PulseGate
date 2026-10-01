import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBody,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { GetWalletUseCase, TopUpWalletUseCase } from '@pulsegate/application';
import {
  ErrorResponseDto,
  TopUpBodyDto,
  WalletBalanceResponseDto,
} from '../dto/api.dto';

@ApiTags('wallets')
@ApiExtraModels(ErrorResponseDto)
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly topUp: TopUpWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
  ) {}

  @Get(':userId')
  @ApiOperation({ summary: 'Get wallet balance (PG SoR + Redis residual)' })
  @ApiParam({
    name: 'userId',
    example: '11111111-1111-1111-1111-111111111111',
  })
  @ApiOkResponse({ type: WalletBalanceResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  get(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<WalletBalanceResponseDto> {
    return this.getWallet.execute(userId);
  }

  @Post(':userId/topups')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Top up wallet (Postgres first, then lease refill to Redis)',
  })
  @ApiParam({
    name: 'userId',
    example: '11111111-1111-1111-1111-111111111111',
  })
  @ApiBody({ type: TopUpBodyDto })
  @ApiOkResponse({ type: WalletBalanceResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  @ApiResponse({ status: 422, type: ErrorResponseDto })
  topup(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: TopUpBodyDto,
  ): Promise<WalletBalanceResponseDto> {
    return this.topUp.execute({ userId, amount: body.amount });
  }
}
