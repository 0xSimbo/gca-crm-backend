export interface HubFarm {
  orderIndex: number;
  id: string;
  humanReadableName: string;
  farmName: string;
  image: string;
  auditDate: string;
  auditorName: string;
  auditorDesc: string;
  auditorImage: string;
  previousShortIds: number[];
  activeShortIds: number[];
  auditDocuments: AuditDocument[];
  preInstallPictures?: AuditDocument[];
  afterInstallPictures?: AuditDocument[];
  summary: {
    address: {
      location: string;
      coordinates: string;
    };
    solarPanels: {
      quantity: number;
      brandAndModel: string;
      warranty: string;
    };
    installationAndOperations: {
      installationDate: string;
      ptoDate: string;
      electricityPrice: string;
    };
    carbonFootprintAndProduction: {
      averageSunlightPerDay: string;
      adjustedWeeklyCarbonCredit: string;
      weeklyTotalCarbonDebt: string;
      netCarbonCreditEarningWeekly: string;
      protocolFees: string;
      systemWattageOutput: string;
    };
  };
}
export interface AuditDocument {
  id: string;
  name: string;
  link: string;
  comment: string | null;
  sortIndex?: number;
  isShowingSolarPanels?: boolean;
}
