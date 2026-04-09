import mongoose from 'mongoose';
const { Schema } = mongoose;

const serviceSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    isPackage: {
      type: Boolean,
      default: false,
    },
    quick_wash: {
      type: Boolean,
      default: false,
    },
    waterSaved: [
      {
        car_length: { type: String },
        savedAmount: { type: String },
      },
    ],
    services: [{ type: Schema.Types.ObjectId, ref: 'service' }],
    pricing: [
      {
        region: {
          type: Schema.Types.ObjectId,
          ref: 'city',
          required: true,
        },
        price_options: [
          {
            carType: {
              type: String,
              enum: ['hatchback', 'sedan', 'luxury', 'suv', 'mini suv'],
              required: true,
            },
            price: {
              type: Number,
              required: true,
            },
            discount: {
              type: Number,
              required: true,
            },
          },
        ],
      },
    ],
    addOns: [
      {
        type: Schema.Types.ObjectId,
        ref: 'service',
      },
    ],
    defaultCarType: {
      type: String,
      enum: ['hatchback', 'sedan', 'luxury', 'suv', 'mini suv'],
    },
    time: String,
    whatIncludes: [
      {
        type: Schema.Types.ObjectId,
        ref: 'whatIncludes',
      },
    ],
    prerequisites: [
      {
        type: Schema.Types.ObjectId,
        ref: 'prerequisites',
      },
    ],
    category: {
      type: Schema.Types.ObjectId,
      ref: 'serviceCategory',
    },
    categories: [
      {
        type: Schema.Types.ObjectId,
        ref: 'serviceCategory',
      },
    ],
    cities: [
      {
        city: {
          type: Schema.Types.ObjectId,
          ref: 'city',
          required: true,
        },
        priority: {
          type: Number,
        },
        status: {
          type: String,
          enum: ['active', 'inactive'],
          default: 'active', // review
        },
      },
    ],
    for_all_cities: Boolean,
    mainPicture: String,
    status: {
      type: String,
      enum: ['0', '1'], // 1 for Active 0 for inactive
    },
    forTwoWheeler: {
      type: Boolean,
    },
    serviceImages: [String],
    priority: [
      {
        city: {
          type: Schema.Types.ObjectId,
          ref: 'city',
        },
        priority: Number,
        status: String,
      },
    ],
    details: [String],
    rating: Number,
    rating_count: Number,
    deliveryCharges: {
      pickAndDrop: {
        type: Number,
        default: 0,
        min: 0,
      },
      doorstepCharge: {
        type: Number,
        default: 0,
      },
      garageVisit: {
        type: Number,
        default: 0,
      },
    },
    carmaaCoins: {
      type: Number,
    },
    approved_by: {
      type: Schema.Types.ObjectId,
      ref: 'employee',
    },
    created_by: {
      type: Schema.Types.ObjectId,
      ref: 'employee',
    },
    updated_by: {
      type: Schema.Types.ObjectId,
      ref: 'employee',
    },
    partnerShare: {
      type: Number,
    },
    additionalPhotos: [
      {
        label: {
          type: String,
          required: true,
        },
        count: {
          type: Number,
          default: 1,
          min: 1,
          max: 5,
        },
        required: {
          type: Boolean,
          default: true,
        },
        _id: false,
      },
    ],
    warranty: {
      type: Boolean,
      default: false,
    },
    warrantyDuration: {
      type: String,
    },
    reviews: [
      {
        type: Schema.Types.ObjectId,
        ref: 'review',
      },
    ],
    not_included: [String],
  },
  { timestamps: true },
);

export const Service = mongoose.model('service', serviceSchema);
