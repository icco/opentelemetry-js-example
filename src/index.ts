import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { MongoDBInstrumentation } from "@opentelemetry/instrumentation-mongodb";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { JaegerPropagator } from "@opentelemetry/propagator-jaeger";
import { B3InjectEncoding, B3Propagator } from "@opentelemetry/propagator-b3";
import {
  AlwaysOnSampler,
  CompositePropagator,
  W3CTraceContextPropagator,
  W3CBaggagePropagator,
} from "@opentelemetry/core";
import {
  Context,
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  Span,
  SpanStatusCode,
  SpanKind,
  TextMapPropagator,
  trace,
  Tracer,
} from "@opentelemetry/api";
import { metrics, Meter } from "@opentelemetry/api-metrics";
import { AWSXRayPropagator } from "@opentelemetry/propagator-aws-xray";
import { OTLPMetricExporter, OTLPTraceExporter } from "@opentelemetry/exporter-otlp-proto";
import { BatchSpanProcessor, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Instrumentation } from "@opentelemetry/instrumentation";
import { NodeSDK, NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { MetricExporter, Processor, UngroupedProcessor } from "@opentelemetry/sdk-metrics-base";
import { NestInstrumentation } from "@opentelemetry/instrumentation-nestjs-core";

const TRACER_NAME = "ping-logger";
const METER_NAME = "ping-logger";

interface OpenTelemetryOptions {
  express?: boolean;
  nest?: boolean;
  mongo?: boolean;
  debug?: boolean;

  environment?: string;
  service: string;
  version?: string;

  sumoTraceURL?: string;
  sumoMetricsURL?: string;
}

function getConfiguration(options: OpenTelemetryOptions): Partial<NodeSDKConfiguration> {
  const version = options.version ?? "unknown";
  const environment = options.environment ?? "unknown";
  const service = options.service;
  const application = environment;

  const resource = new Resource({
    // Application is a field for Sumologic, and not standard to OT.
    // https://help.sumologic.com/Traces/Service_Map_and_Dashboards
    application,
    // Standard resources
    // https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/resource/semantic_conventions/README.md
    [SemanticResourceAttributes.SERVICE_NAME]: service,
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: environment,
    [SemanticResourceAttributes.SERVICE_VERSION]: version,
  });
  const contextManager = new AsyncLocalStorageContextManager();

  let textMapPropagator: TextMapPropagator | undefined;
  let spanProcessor: SpanProcessor | undefined;
  let traceExporter: SpanExporter | undefined;
  if (options.sumoTraceURL) {
    traceExporter = new OTLPTraceExporter({
      url: options.sumoTraceURL,
    });
    spanProcessor = new BatchSpanProcessor(traceExporter);
    textMapPropagator = new CompositePropagator({
      propagators: [
        new JaegerPropagator(),
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
        new B3Propagator(),
        new B3Propagator({
          injectEncoding: B3InjectEncoding.MULTI_HEADER,
        }),
        new AWSXRayPropagator(),
      ],
    });
  }

  // If there is a sumo metrics url, enable metrics
  let metricProcessor: Processor | undefined;
  let metricExporter: MetricExporter | undefined;
  if (options.sumoMetricsURL) {
    metricExporter = new OTLPMetricExporter({
      url: options.sumoMetricsURL,
    });
    metricProcessor = new UngroupedProcessor();
  }

  const instrumentations: Instrumentation[] = [new HttpInstrumentation()];

  // express
  if (options.express) {
    instrumentations.push(new ExpressInstrumentation());
  }

  // nest?
  if (options.nest) {
    instrumentations.push(new NestInstrumentation());
  }

  // mongo
  if (options.mongo) {
    instrumentations.push(
      new MongoDBInstrumentation({
        enhancedDatabaseReporting: true,
        responseHook: function (span, responseInfo: any) {
          // As responseInfo.data.result can contain sensitive user info, we omit that from the span metadata
          // DB collection name is already in the metadata.
          //
          // See https://docs.mongodb.com/manual/reference/method/db.runCommand/#response for operationTime definition.
          if (responseInfo.data.result.operationTime !== undefined) {
            span.setAttribute(
              "db.operation_time",
              JSON.stringify(responseInfo.data.result.operationTime),
            );
          }

          if (responseInfo.data.connection !== undefined) {
            for (const [key, value] of Object.entries(responseInfo.data.connection)) {
              span.setAttribute(`db.connection.${key}`, JSON.stringify(value));
            }
          }

          if (options.debug) {
            span.setAttribute("config.debug", "true");
          }
        },
      }),
    );
  }

  if (options.debug) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  return {
    autoDetectResources: true,
    contextManager,
    defaultAttributes: {},
    instrumentations,
    metricInterval: 1000,
    metricProcessor,
    metricExporter,
    resource,
    sampler: new AlwaysOnSampler(),
    spanLimits: {},
    spanProcessor,
    traceExporter,
    textMapPropagator,
  };
}

function createInstrumentation(options: Partial<NodeSDKConfiguration>): NodeSDK {
  return new NodeSDK(options);
}
