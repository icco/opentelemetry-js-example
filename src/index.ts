import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
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
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  TextMapPropagator,
} from "@opentelemetry/api";
import { AWSXRayPropagator } from "@opentelemetry/propagator-aws-xray";
import { OTLPMetricExporter, OTLPTraceExporter } from "@opentelemetry/exporter-otlp-proto";
import { BatchSpanProcessor, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Instrumentation } from "@opentelemetry/instrumentation";
import { NodeSDK, NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { MetricExporter, Processor, UngroupedProcessor } from "@opentelemetry/sdk-metrics-base";
import express from "express";
import { metrics } from "@opentelemetry/api-metrics";

interface OpenTelemetryOptions {
  express?: boolean;
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


const sdk = createInstrumentation(getConfiguration({
  express: true,
  debug: true,

  service: "nat-example",
  environment: "dev-local",
  version: process.env.npm_package_version,

  sumoTraceURL: process.env.SUMOLOGIC_TRACE_URL,
  sumoMetricsURL: process.env.SUMOLOGIC_METRIC_URL,
}))
sdk.start()

const app = express()

app.get('/', (req, res) => {
  metrics.getMeter("example").createCounter("nat-counter").add(1)
  res.send('Hello World!')
})

const port = 8080;
app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`)
})
