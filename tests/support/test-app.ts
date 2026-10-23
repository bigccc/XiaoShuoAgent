import { AppServices as ProductionAppServices } from '../../src/main/services';
import { billable } from '../../src/shared/billing';
import type { Command } from '../../src/shared/types';
/** Local mock model fixtures explicitly declare free prices and zero money authorization.
 * Billing guard tests import the production service directly. No production behavior is bypassed. */
export class AppServices extends ProductionAppServices {
  override dispatch(command: Command) {
    let fixtureCommand: any = command;
    if (command.type === 'profile.save' && command.pricing === undefined)
      fixtureCommand = { ...command, pricing: { currency: 'CNY', input: 0, output: 0 } };
    if (billable(command.type) && (command as any).billing === undefined)
      fixtureCommand = { ...fixtureCommand, billing: { budgetMicros: 0 } };
    return super.dispatch(fixtureCommand);
  }
}
