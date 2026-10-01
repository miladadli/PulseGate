import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { GetSmsByIdUseCase, GetSmsReportsUseCase } from '@pulsegate/application';
import { ErrorResponseDto, SmsReportItemDto } from '../dto/api.dto';

@ApiTags('reports')
@Controller()
export class ReportsController {
  constructor(
    private readonly reports: GetSmsReportsUseCase,
    private readonly byId: GetSmsByIdUseCase,
  ) {}

  @Get('reports/sms')
  @ApiOperation({
    summary: 'Query SMS reports from ClickHouse (ReplacingMergeTree FINAL)',
  })
  @ApiQuery({
    name: 'userId',
    required: true,
    example: '11111111-1111-1111-1111-111111111111',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    example: '2026-09-01T00:00:00.000Z',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    example: '2026-09-30T23:59:59.999Z',
  })
  @ApiQuery({ name: 'status', required: false, example: 'delivered' })
  @ApiQuery({ name: 'priority', required: false, example: 'express' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiOkResponse({ type: SmsReportItemDto, isArray: true })
  list(
    @Query('userId') userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('limit') limit?: string,
  ): Promise<SmsReportItemDto[]> {
    return this.reports.execute({
      userId,
      from,
      to,
      status,
      priority,
      limit: limit ? Number(limit) : 50,
    });
  }

  @Get('sms/:id')
  @ApiOperation({
    summary: 'Get one SMS (Redis accept-cache first, then ClickHouse)',
  })
  @ApiParam({
    name: 'id',
    example: '9d96a40f-e56b-58a8-a9a5-112aa0948493',
  })
  @ApiOkResponse({ type: SmsReportItemDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async getOne(@Param('id') id: string): Promise<SmsReportItemDto> {
    const row = await this.byId.execute(id);
    if (!row) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'SMS_NOT_FOUND',
        message: `SMS ${id} not found`,
      });
    }
    return row;
  }
}
